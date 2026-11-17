// Live voice: a hands-free loop of listen -> ask -> speak, with every answer still going through /chat and grounding.
//
// Listening: the microphone streams over WebRTC to an OpenAI realtime *transcription* session. The browser gets a
// short-lived client secret from POST /voice/session; the API key never leaves the server. Server-side voice
// activity detection marks each finished utterance, and its transcript is sent as a normal chat question.
// Speaking: GET /voice/speak?trace_id=... streams OpenAI TTS of the answer the server verified for that turn (the
// client cannot choose the text). Talking while it speaks lowers the voice at once and, if it was a new question
// rather than the speaker's own echo, stops it and asks.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createMeter, type Meter } from './liveAudio'

export type LiveState = 'off' | 'connecting' | 'listening' | 'thinking' | 'speaking'

export interface VoiceSession {
  client_secret: string
  connect_url: string
  max_session_seconds: number
  transcribe_model?: string
}

/** Chrome and Edge (Chromium) with WebRTC and a microphone API. Elsewhere the Live button explains why it is off. */
export function liveSupported(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false
  const brands = (navigator as Navigator & { userAgentData?: { brands?: { brand: string }[] } }).userAgentData?.brands ?? []
  const chromium = brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/.test(b.brand))
  return chromium && typeof window.RTCPeerConnection === 'function' && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

export const UNSUPPORTED_HINT = 'Live voice works in Chrome and Edge on a computer with a microphone.'

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)

/**
 * True when a transcript is the speaker's own voice picked up by the microphone, not a new question: most of its
 * words are in the text being spoken. Echo cancellation catches most of it; this is the safety net.
 */
export function isEcho(transcript: string, spoken: string): boolean {
  const heard = words(transcript)
  if (heard.length === 0) return true
  const said = new Set(words(spoken))
  if (said.size === 0) return false
  const inSpoken = heard.filter((w) => said.has(w)).length
  return inSpoken / heard.length >= 0.7
}

/** A transcript worth sending: some letters, not just a cough or "um". */
export function isQuestion(transcript: string): boolean {
  const w = words(transcript)
  return w.length >= 2 || (w.length === 1 && w[0].length >= 4)
}

type Listener = () => void

export interface LiveDeps {
  fetch: typeof fetch
  getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
  createPeer: () => RTCPeerConnection
  createAudio: () => HTMLAudioElement
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (id: unknown) => void
  /** Audio levels for the waveform; null where Web Audio is missing (the waveform then stays idle). */
  createMeter?: () => Meter | null
}

function defaultDeps(): LiveDeps {
  return {
    fetch: (...a) => fetch(...a),
    getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
    createPeer: () => new RTCPeerConnection(),
    createAudio: () => new Audio(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
    createMeter,
  }
}

async function detail(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json()
    return typeof body?.detail === 'string' ? body.detail : fallback
  } catch {
    return fallback
  }
}

/**
 * The live session as a small state machine, independent of React (the hook below wraps it).
 * `onUtterance` gets each finished question; the chat calls `answered(traceId)` when the verified answer is in.
 */
export class LiveVoice {
  state: LiveState = 'off'
  error: string | null = null
  hint: string | null = null
  interim = ''
  endsAt: number | null = null
  muted = false
  private listeners = new Set<Listener>()
  private peer: RTCPeerConnection | null = null
  private stream: MediaStream | null = null
  private audio: HTMLAudioElement | null = null // one element per session: Web Audio can attach to it only once
  private playing = false
  private meter: Meter | null = null
  private spokenText = ''
  private capTimer: unknown = null
  private run = 0 // bumps on every start/stop, so late events of an old session are ignored

  constructor(
    private onUtterance: (text: string) => void,
    private deps: LiveDeps = defaultDeps(),
  ) {}

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }

  private set(patch: Partial<Pick<LiveVoice, 'state' | 'error' | 'hint' | 'interim' | 'endsAt' | 'muted'>>) {
    Object.assign(this, patch)
    this.listeners.forEach((l) => l())
  }

  setHandler(onUtterance: (text: string) => void) {
    this.onUtterance = onUtterance
  }

  async start(): Promise<void> {
    if (this.state !== 'off') return
    const run = ++this.run
    // Created inside the click that started Live, so the browser lets the audio context run.
    this.meter = this.deps.createMeter?.() ?? null
    this.set({ state: 'connecting', error: null, hint: null, interim: '', muted: false })
    try {
      const res = await this.deps.fetch('/voice/session', { method: 'POST' })
      if (!res.ok) throw new Error(await detail(res, 'Live voice is unavailable right now.'))
      const session = (await res.json()) as VoiceSession
      const stream = await this.deps
        .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .catch(() => {
          throw new Error('Microphone access is blocked. Allow it in the browser to use Live voice.')
        })
      if (run !== this.run) return void stream.getTracks().forEach((t) => t.stop())
      this.stream = stream
      this.meter?.mic(stream)
      const pc = this.deps.createPeer()
      this.peer = pc
      stream.getTracks().forEach((t) => pc.addTrack(t, stream))
      const channel = pc.createDataChannel('oai-events')
      channel.onmessage = (e) => this.onEvent(run, e.data)
      pc.onconnectionstatechange = () => {
        if (run === this.run && (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')) this.stop('The live connection dropped. Start Live again to continue.')
      }
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      const sdp = await this.deps.fetch(session.connect_url, {
        method: 'POST',
        body: offer.sdp,
        headers: { Authorization: `Bearer ${session.client_secret}`, 'Content-Type': 'application/sdp' },
      })
      if (!sdp.ok) throw new Error('Could not connect to live transcription.')
      await pc.setRemoteDescription({ type: 'answer', sdp: await sdp.text() })
      if (run !== this.run) return
      const seconds = Math.max(60, session.max_session_seconds || 600)
      this.capTimer = this.deps.setTimer(() => {
        if (run === this.run) this.stop(`Live voice ends after ${Math.round(seconds / 60)} minutes. Start it again to keep talking.`)
      }, seconds * 1000)
      this.set({ state: (this.state as LiveState) === 'connecting' ? 'listening' : this.state, endsAt: Date.now() + seconds * 1000 })
    } catch (err) {
      if (run === this.run) this.stop(err instanceof Error ? err.message : 'Live voice failed to start.')
    }
  }

  /** End the session: close the call and the microphone, stop speaking. `error` is shown after it stops. */
  stop(error: string | null = null): void {
    this.run++
    if (this.capTimer !== null) this.deps.clearTimer(this.capTimer)
    this.capTimer = null
    this.stopAudio()
    this.audio = null
    this.meter?.close()
    this.meter = null
    this.peer?.close()
    this.peer = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.set({ state: 'off', error, hint: null, interim: '', endsAt: null, muted: false })
  }

  /** The chat sent a question (typed or spoken) and is working on it. */
  thinking(): void {
    if (this.state === 'listening' || this.state === 'speaking') {
      this.stopAudio()
      this.set({ state: 'thinking', hint: null })
    }
  }

  /** The turn is over: speak its verified answer (by trace id), or just listen again when there is none. */
  answered(traceId: string | null, spokenText = ''): void {
    if (this.state === 'off' || this.state === 'connecting') return
    if (!traceId) return this.set({ state: 'listening' })
    this.stopAudio()
    if (!this.audio) {
      this.audio = this.deps.createAudio()
      this.meter?.speaker(this.audio)
    }
    const audio = this.audio
    const play = ++this.playId
    this.spokenText = spokenText
    const done = () => {
      if (play !== this.playId || !this.playing) return
      this.playing = false
      if (this.state === 'speaking') this.set({ state: 'listening' })
    }
    audio.onended = done
    audio.onerror = () => {
      done()
      if (this.state !== 'off') this.set({ hint: 'The answer could not be read aloud. It is on screen.' })
    }
    audio.volume = 1
    audio.src = `/voice/speak?trace_id=${encodeURIComponent(traceId)}`
    this.playing = true
    this.meter?.resume()
    this.set({ state: 'speaking', hint: null })
    void audio.play().catch(done)
  }

  /** Skip the rest of the spoken answer and listen. */
  skip(): void {
    if (this.state !== 'speaking') return
    this.stopAudio()
    this.set({ state: 'listening' })
  }

  /** Mute or unmute the microphone (the call stays open; nothing is heard while muted). */
  toggleMute(): void {
    if (this.state === 'off') return
    const muted = !this.muted
    this.stream?.getTracks().forEach((t) => (t.enabled = !muted))
    this.set({ muted, interim: muted ? '' : this.interim })
  }

  /** Waveform bars for the current state: the microphone while listening, the answer while speaking. */
  levels(n: number): number[] | null {
    if (this.state === 'listening') return this.muted ? null : (this.meter?.read('mic', n) ?? null)
    if (this.state === 'speaking') return this.meter?.read('speaker', n) ?? null
    return null
  }

  private playId = 0

  private stopAudio() {
    const a = this.audio
    this.playing = false
    this.playId++
    if (a) {
      a.onended = null
      a.onerror = null
      a.pause()
      a.removeAttribute('src')
    }
  }

  private onEvent(run: number, raw: unknown) {
    if (run !== this.run || typeof raw !== 'string') return
    let e: { type?: string; transcript?: string; delta?: string; error?: { message?: string } }
    try {
      e = JSON.parse(raw)
    } catch {
      return
    }
    switch (e.type) {
      case 'input_audio_buffer.speech_started':
        // Barge-in: lower the voice now; the transcript decides whether it was a question or our own echo.
        if (this.state === 'speaking' && this.playing && this.audio) this.audio.volume = 0.15
        if (this.state === 'listening') this.set({ interim: '' })
        break
      case 'conversation.item.input_audio_transcription.delta':
        if (this.state === 'listening' || this.state === 'speaking') this.set({ interim: (this.interim + (e.delta ?? '')).slice(-300) })
        break
      case 'conversation.item.input_audio_transcription.completed':
        this.onTranscript((e.transcript ?? '').trim())
        break
      case 'error':
        this.set({ hint: e.error?.message ? `Transcription: ${e.error.message}` : 'Transcription error.' })
        break
    }
  }

  private onTranscript(text: string) {
    if (this.state === 'speaking') {
      if (!isQuestion(text) || isEcho(text, this.spokenText)) {
        if (this.audio) this.audio.volume = 1
        this.set({ interim: '' })
        return
      }
      this.stopAudio()
    } else if (this.state === 'thinking') {
      this.set({ hint: 'Still answering the last question; ask again when it is done.', interim: '' })
      return
    } else if (this.state !== 'listening') {
      return
    }
    if (!isQuestion(text)) return this.set({ interim: '' })
    this.set({ state: 'thinking', interim: '', hint: null })
    this.onUtterance(text)
  }
}

/** React binding: one LiveVoice per chat thread, stopped when the thread unmounts. */
export function useLiveVoice(onUtterance: (text: string) => void, deps?: LiveDeps) {
  const ref = useRef<LiveVoice | null>(null)
  if (ref.current === null) ref.current = new LiveVoice(onUtterance, deps)
  const live = ref.current
  live.setHandler(onUtterance)
  const snapshot = useSyncExternalStore(
    live.subscribe,
    () => `${live.state}|${live.error}|${live.hint}|${live.interim}|${live.endsAt}|${live.muted}`,
    () => 'off',
  )
  void snapshot
  useEffect(() => () => live.stop(), [live])
  const [supported] = useState(liveSupported)
  const start = useCallback(() => void live.start(), [live])
  const stop = useCallback(() => live.stop(), [live])
  const skip = useCallback(() => live.skip(), [live])
  const toggleMute = useCallback(() => live.toggleMute(), [live])
  const levels = useCallback((n: number) => live.levels(n), [live])
  return {
    live, supported, state: live.state, error: live.error, hint: live.hint, interim: live.interim, endsAt: live.endsAt, muted: live.muted,
    start, stop, skip, toggleMute, levels,
  }
}
