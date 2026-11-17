import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ChatResponse } from './types'

// Minimal Web Speech API typings (not in lib.dom for all TS versions).
interface SpeechRecognitionResultLike {
  0: { transcript: string }
  isFinal: boolean
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}
type RecognitionCtor = new () => SpeechRecognitionLike

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Stop listening after this long without new speech. */
export const SILENCE_MS = 8000

const join = (...parts: string[]) => parts.join(' ').replace(/\s+/g, ' ').trim()

/**
 * Dictation that keeps listening until the user stops it (or sends). Browsers end a recognition session on a
 * short silence or after about a minute; while the user still wants to listen, a new session starts and the text
 * already captured is kept. About 8 s without new speech stops it, with a "Stopped listening" hint.
 * `onText` receives the whole dictated text so far (final words plus the current interim guess).
 */
export function useDictation(onText: (text: string, final: boolean) => void) {
  const supported = recognitionCtor() !== null
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const rec = useRef<SpeechRecognitionLike | null>(null)
  const want = useRef(false) // the user has not stopped
  const committed = useRef('') // final text from sessions that already ended
  const session = useRef('') // final text of the current session
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cb = useRef(onText)
  cb.current = onText

  const clearSilence = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }

  const armSilence = useCallback(() => {
    clearSilence()
    timer.current = setTimeout(() => {
      if (!want.current) return
      want.current = false
      setHint('Stopped listening')
      rec.current?.stop()
    }, SILENCE_MS)
  }, [])

  const begin = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) return
    const r = new Ctor()
    r.lang = 'en-US'
    r.continuous = true
    r.interimResults = true
    session.current = ''
    r.onresult = (e) => {
      let finalText = ''
      let interim = ''
      for (let i = 0; i < e.results.length; i++) {
        const t = e.results[i][0].transcript
        if (e.results[i].isFinal) finalText += ` ${t}`
        else interim += ` ${t}`
      }
      session.current = join(finalText)
      armSilence()
      cb.current(join(committed.current, finalText, interim), interim.trim() === '')
    }
    r.onerror = (e) => {
      // Silence and our own aborts are normal: the session ends and, if still wanted, restarts.
      if (e.error === 'no-speech' || e.error === 'aborted') return
      want.current = false
      const blocked = e.error === 'not-allowed' || e.error === 'service-not-allowed'
      setError(blocked ? 'Microphone access is blocked. Allow it in the browser to dictate.' : `Voice input stopped: ${e.error}.`)
    }
    r.onend = () => {
      committed.current = join(committed.current, session.current)
      session.current = ''
      if (rec.current !== r) return
      if (want.current) {
        try {
          begin()
          return
        } catch {
          want.current = false
        }
      }
      clearSilence()
      setListening(false)
    }
    rec.current = r
    r.start()
  }, [armSilence])

  const start = useCallback(() => {
    if (!recognitionCtor()) return
    want.current = true
    committed.current = ''
    setError(null)
    setHint(null)
    setListening(true)
    begin()
    armSilence()
  }, [begin, armSilence])

  const stop = useCallback(() => {
    want.current = false
    clearSilence()
    rec.current?.stop()
  }, [])

  useEffect(
    () => () => {
      want.current = false
      clearSilence()
      rec.current?.stop()
    },
    [],
  )

  return { supported, listening, error, hint, start, stop }
}

export function speechSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as { speechSynthesis?: { speak?: unknown } }).speechSynthesis?.speak === 'function' &&
    typeof SpeechSynthesisUtterance !== 'undefined'
  )
}

/** Markdown to plain text that reads well aloud. */
export function toSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** What the speaker reads: the answer text, flagged when its numbers failed verification. */
export function answerSpeech(r: ChatResponse): string {
  const text = toSpeech(r.answer.answer)
  return r.grounding.status === 'failed' ? `Unverified answer. ${text}` : text
}

// ---------- one speaker for the whole page: starting an answer stops the one being read ----------

let speakingId: string | null = null
let current: SpeechSynthesisUtterance | null = null
const listeners = new Set<() => void>()

function setSpeaking(id: string | null) {
  speakingId = id
  listeners.forEach((l) => l())
}

/** Read one message aloud (its id marks which button shows "Stop"). */
export function speakMessage(id: string, text: string): void {
  if (!speechSupported()) return
  current = null // the cancelled utterance's onend must not reset the new one
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.lang = 'en-US'
  const done = () => {
    if (current === u) {
      current = null
      setSpeaking(null)
    }
  }
  u.onend = done
  u.onerror = done
  current = u
  setSpeaking(id)
  window.speechSynthesis.speak(u)
}

export function stopSpeaking(): void {
  current = null
  if (speakingId !== null) setSpeaking(null)
  if (speechSupported()) window.speechSynthesis.cancel()
}

/** The id of the message being read, or null. */
export function useSpeakingId(): string | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => speakingId,
    () => null,
  )
}
