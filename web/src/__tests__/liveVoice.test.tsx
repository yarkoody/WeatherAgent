// Live voice: the voice dock (orb, label, waveform, timer, mute, end), the ghost transcript bubble, the session state
// machine with fake WebRTC, and the web sources display.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../components/ChatView'
import { Composer, LIVE_ERROR_MS } from '../components/Composer'
import { FiguresTable } from '../components/FiguresTable'
import { LIVE_LABEL, LiveButton, Orb, VoiceDock, liveHint, type LiveView } from '../components/LiveControls'
import { barsFromBins } from '../lib/liveAudio'
import { LiveVoice, UNSUPPORTED_HINT, isEcho, isQuestion, type LiveDeps, type LiveState } from '../lib/liveVoice'
import { toolLabel } from '../lib/toolLabels'
import { WEB_LABEL, type Figure, type WebSearchResult } from '../lib/types'
import { WebSources } from '../widgets/WebSources'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function view(state: LiveState, patch: Partial<LiveView> = {}): LiveView {
  return {
    supported: true, state, error: null, hint: null, interim: '', endsAt: null, muted: false,
    start: vi.fn(), stop: vi.fn(), skip: vi.fn(), toggleMute: vi.fn(), levels: () => null, ...patch,
  }
}

/** matchMedia where only prefers-reduced-motion can match. */
function motion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q === '(prefers-reduced-motion: reduce)', addEventListener() {}, removeEventListener() {} }))
}

describe('voice dock', () => {
  it('Live replaces the text box with the dock, and End brings the box back with focus', () => {
    const off = view('off')
    const { rerender } = render(<Composer busy={false} onSend={() => {}} onStop={() => {}} live={off} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start live voice' }))
    expect(off.start).toHaveBeenCalled()
    const on = view('listening')
    rerender(<Composer busy={false} onSend={() => {}} onStop={() => {}} live={on} />)
    expect(screen.getByTestId('voice-dock')).toHaveAttribute('data-state', 'listening')
    expect(screen.queryByRole('textbox', { name: 'Ask about hub weather risk' })).toBeNull() // hidden while Live is on
    expect(screen.getByRole('button', { name: 'End live voice' })).toHaveFocus()
    fireEvent.click(screen.getByRole('button', { name: 'End live voice' }))
    expect(on.stop).toHaveBeenCalled()
    rerender(<Composer busy={false} onSend={() => {}} onStop={() => {}} live={view('off')} />)
    expect(screen.queryByTestId('voice-dock')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Ask about hub weather risk' })).toHaveFocus()
  })

  it.each([
    ['connecting', 'Connecting', 'Allow the microphone if asked'],
    ['listening', 'Listening', "Pause when you're done"],
    ['thinking', 'Checking the figures', 'Running 2 tools'],
    ['speaking', 'Speaking', 'Talk to interrupt, or tap the orb to skip'],
  ] as [LiveState, string, string][])('shows the %s state with one label and one hint', (state, label, hint) => {
    render(<VoiceDock live={view(state)} tools={2} />)
    expect(screen.getByTestId('voice-dock')).toHaveAttribute('data-state', state)
    expect(screen.getByTestId('live-label')).toHaveTextContent(label)
    expect(screen.getByTestId('live-hint')).toHaveTextContent(hint)
    expect(screen.getByTestId('orb')).toHaveAttribute('data-state', state)
    expect(screen.getByTestId('live-label').parentElement).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('button', { name: 'End live voice' })).toBeInTheDocument()
  })

  it('thinking without tools yet says every figure is checked', () => {
    expect(liveHint('thinking')).toBe('Every figure is checked first')
    expect(liveHint('thinking', { tools: 1 })).toBe('Running 1 tool')
  })

  it('the orb is a skip button only while speaking', () => {
    const live = view('speaking')
    render(<VoiceDock live={live} />)
    fireEvent.click(screen.getByRole('button', { name: 'Skip the spoken answer' }))
    expect(live.skip).toHaveBeenCalled()
    render(<Orb state="listening" reduced={false} onSkip={vi.fn()} />)
    expect(screen.getAllByRole('button', { name: 'Skip the spoken answer' })).toHaveLength(1)
  })

  it('mute toggles the microphone and says so', () => {
    const live = view('listening')
    const { rerender } = render(<VoiceDock live={live} />)
    fireEvent.click(screen.getByRole('button', { name: 'Mute microphone' }))
    expect(live.toggleMute).toHaveBeenCalled()
    rerender(<VoiceDock live={{ ...live, muted: true }} />)
    expect(screen.getByRole('button', { name: 'Unmute microphone' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('live-hint')).toHaveTextContent('Mic muted')
  })

  it('shows the time left', () => {
    vi.useFakeTimers({ now: 1_000_000 })
    render(<VoiceDock live={view('listening', { endsAt: 1_000_000 + 9 * 60_000 + 5_000 })} />)
    expect(screen.getByTestId('live-time')).toHaveTextContent('9:05')
    act(() => vi.advanceTimersByTime(6_000))
    expect(screen.getByTestId('live-time')).toHaveTextContent('8:59')
  })

  it('animates with motion allowed and stays still, with color and label, under reduced motion', () => {
    motion(false)
    const { unmount } = render(<VoiceDock live={view('listening')} />)
    expect(screen.getByTestId('orb')).toHaveAttribute('data-reduced', 'false')
    expect(screen.getByTestId('orb-halo').className).toContain('voice-halo-listening')
    unmount()
    motion(true)
    render(<VoiceDock live={view('thinking')} />)
    expect(screen.getByTestId('orb')).toHaveAttribute('data-reduced', 'true')
    expect(screen.getByTestId('orb-ring').className).not.toContain('voice-ring-thinking')
    expect(screen.getByTestId('waveform').innerHTML).not.toContain('voice-bar-idle')
    expect(screen.getByTestId('live-label')).toHaveTextContent('Checking the figures')
  })

  it('draws the waveform from audio levels while listening, and a shimmer while checking', async () => {
    motion(false)
    const levels = vi.fn(() => Array.from({ length: 36 }, (_, i) => (i === 0 ? 0.9 : 0.2)))
    const { unmount } = render(<VoiceDock live={view('listening', { levels })} />)
    expect(screen.getByTestId('waveform')).toHaveAttribute('data-mode', 'audio')
    await waitFor(() => expect(levels).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByTestId('waveform').firstChild as HTMLElement).style.transform).toBe('scaleY(0.9)'))
    unmount()
    const calls = levels.mock.calls.length
    await new Promise((r) => setTimeout(r, 50))
    expect(levels.mock.calls.length).toBe(calls) // the animation loop stopped with the dock
    render(<VoiceDock live={view('thinking', { levels })} />)
    expect(screen.getByTestId('waveform')).toHaveAttribute('data-mode', 'idle')
    expect(screen.getByTestId('waveform').innerHTML).toContain('voice-bar-idle')
  })

  it('an error shows in the dock, then the dock closes', () => {
    vi.useFakeTimers()
    const { rerender } = render(<Composer busy={false} onSend={() => {}} onStop={() => {}} live={view('listening')} />)
    rerender(<Composer busy={false} onSend={() => {}} onStop={() => {}} live={view('off', { error: 'The live connection dropped.' })} />)
    expect(screen.getByTestId('voice-dock')).toHaveAttribute('data-state', 'error')
    expect(screen.getByRole('alert')).toHaveTextContent('The live connection dropped.')
    act(() => vi.advanceTimersByTime(LIVE_ERROR_MS))
    expect(screen.queryByTestId('voice-dock')).toBeNull()
  })

  it('shows the fallback message outside Chrome and Edge', () => {
    const live = view('off', { supported: false })
    render(<LiveButton live={live} />)
    const button = screen.getByRole('button', { name: `Live voice: ${UNSUPPORTED_HINT}` })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    expect(live.start).not.toHaveBeenCalled()
  })

  it('labels every state', () => {
    expect(Object.keys(LIVE_LABEL).sort()).toEqual(['connecting', 'listening', 'speaking', 'thinking'])
  })
})

describe('ghost transcript bubble', () => {
  it('fills in while listening and becomes the sent question', async () => {
    const channel = new FakeChannel()
    class Peer {
      addTrack() {}
      createDataChannel() {
        return channel
      }
      async createOffer() {
        return { type: 'offer', sdp: 'offer' }
      }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      close() {}
      connectionState = 'connected'
      onconnectionstatechange = null
    }
    vi.stubGlobal('RTCPeerConnection', Peer)
    Object.defineProperty(navigator, 'userAgentData', { value: { brands: [{ brand: 'Chromium' }] }, configurable: true })
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {}, enabled: true }] }) }, configurable: true })
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url === '/voice/session') return Response.json({ client_secret: 'ek_1', connect_url: 'https://rt.example/calls', max_session_seconds: 600 })
        if (url === 'https://rt.example/calls') return new Response('answer')
        return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } })
      }),
    )
    render(<ChatView sessionId="ghost-test" />)
    fireEvent.click(screen.getByRole('button', { name: 'Start live voice' }))
    await waitFor(() => expect(screen.getByTestId('voice-dock')).toHaveAttribute('data-state', 'listening'))

    act(() => channel.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Which hubs flood' }))
    const ghost = screen.getByTestId('ghost-bubble')
    expect(ghost).toHaveTextContent('Which hubs flood')
    expect(ghost.className).toContain('border-dashed')
    act(() => channel.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: ' the most?' }))
    expect(screen.getByTestId('ghost-bubble')).toHaveTextContent('Which hubs flood the most?')

    act(() => channel.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'Which hubs flood the most?' }))
    await waitFor(() => expect(screen.queryByTestId('ghost-bubble')).toBeNull())
    expect(screen.getByText('Which hubs flood the most?')).toBeInTheDocument() // now the normal question bubble
    expect(screen.getByTestId('voice-dock')).toHaveAttribute('data-state', 'thinking')
    fireEvent.click(screen.getByRole('button', { name: 'End live voice' }))
  })
})

// ---------- the state machine, with fake fetch / microphone / WebRTC / audio ----------

class FakeChannel {
  onmessage: ((e: { data: string }) => void) | null = null
  emit(event: object) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
}

function fakes(sessionStatus = 200) {
  const channel = new FakeChannel()
  const track = { stop: vi.fn(), enabled: true }
  const peer = {
    addTrack: vi.fn(),
    createDataChannel: vi.fn(() => channel),
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'v=0 offer' })),
    setLocalDescription: vi.fn(async () => {}),
    setRemoteDescription: vi.fn(async () => {}),
    close: vi.fn(),
    connectionState: 'connected',
    onconnectionstatechange: null as null | (() => void),
  }
  const audio = { src: '', volume: 1, play: vi.fn(async () => {}), pause: vi.fn(), removeAttribute: vi.fn(), onended: null as null | (() => void), onerror: null as null | (() => void) }
  const timers: (() => void)[] = []
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/voice/session')
      return sessionStatus === 200
        ? new Response(JSON.stringify({ client_secret: 'ek_1', connect_url: 'https://api.openai.com/v1/realtime/calls', max_session_seconds: 600 }), { status: 200 })
        : new Response(JSON.stringify({ detail: 'The daily live-voice cap for this demo has been reached.' }), { status: sessionStatus })
    return new Response('v=0 answer', { status: 201 })
  })
  const deps: LiveDeps = {
    fetch: fetchMock as unknown as typeof fetch,
    getUserMedia: vi.fn(async () => ({ getTracks: () => [track] }) as unknown as MediaStream),
    createPeer: () => peer as unknown as RTCPeerConnection,
    createAudio: () => audio as unknown as HTMLAudioElement,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
  }
  return { deps, channel, peer, audio, track, timers, fetchMock }
}

const completed = (transcript: string) => ({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'i1', transcript })

describe('LiveVoice session', () => {
  it('connects with an ephemeral secret, sends each utterance and speaks the verified answer', async () => {
    const f = fakes()
    const asked: string[] = []
    const live = new LiveVoice((t) => asked.push(t), f.deps)
    await live.start()
    expect(live.state).toBe('listening')
    const [, init] = f.fetchMock.mock.calls[1] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ek_1')
    expect(init.body).toBe('v=0 offer')
    expect(f.peer.createDataChannel).toHaveBeenCalledWith('oai-events')

    f.channel.emit({ type: 'conversation.item.input_audio_transcription.delta', delta: 'Which hub ' })
    expect(live.interim).toBe('Which hub ')
    f.channel.emit(completed('Which hub has the most flood risk?'))
    expect(asked).toEqual(['Which hub has the most flood risk?'])
    expect(live.state).toBe('thinking')

    // while thinking, new speech is not sent
    f.channel.emit(completed('And Miami?'))
    expect(asked).toHaveLength(1)

    live.answered('trace-123', 'Houston leads on flood exposure.')
    expect(live.state).toBe('speaking')
    expect(f.audio.src).toBe('/voice/speak?trace_id=trace-123')
    act(() => f.audio.onended?.())
    expect(live.state).toBe('listening')
  })

  it('ignores its own echo while speaking but stops for a new question', async () => {
    const f = fakes()
    const asked: string[] = []
    const live = new LiveVoice((t) => asked.push(t), f.deps)
    await live.start()
    live.answered('t1', 'Houston has the highest flood exposure of the hubs.')
    f.channel.emit({ type: 'input_audio_buffer.speech_started' })
    expect(f.audio.volume).toBeLessThan(1) // ducked at once
    f.channel.emit(completed('highest flood exposure of the hubs'))
    expect(asked).toEqual([])
    expect(live.state).toBe('speaking')
    expect(f.audio.volume).toBe(1)

    f.channel.emit({ type: 'input_audio_buffer.speech_started' })
    f.channel.emit(completed('What about Denver in winter?'))
    expect(f.audio.pause).toHaveBeenCalled()
    expect(asked).toEqual(['What about Denver in winter?'])
    expect(live.state).toBe('thinking')
  })

  it('listens again when a turn has no verified answer to speak', async () => {
    const f = fakes()
    const live = new LiveVoice(() => {}, f.deps)
    await live.start()
    f.channel.emit(completed('Compare Dallas and Houston'))
    live.answered(null)
    expect(live.state).toBe('listening')
  })

  it('shows the server refusal and never opens the microphone', async () => {
    const f = fakes(429)
    const live = new LiveVoice(() => {}, f.deps)
    await live.start()
    expect(live.state).toBe('off')
    expect(live.error).toMatch(/daily live-voice cap/)
    expect(f.deps.getUserMedia).not.toHaveBeenCalled()
  })

  it('ends the session at the time cap and releases the microphone', async () => {
    const f = fakes()
    const live = new LiveVoice(() => {}, f.deps)
    await live.start()
    f.timers[0]()
    expect(live.state).toBe('off')
    expect(live.error).toMatch(/ends after 10 minutes/)
    expect(f.peer.close).toHaveBeenCalled()
    expect(f.track.stop).toHaveBeenCalled()
  })

  it('stop ends everything and late events are ignored', async () => {
    const f = fakes()
    const asked: string[] = []
    const live = new LiveVoice((t) => asked.push(t), f.deps)
    await live.start()
    live.stop()
    f.channel.emit(completed('Is Newark at risk?'))
    expect(asked).toEqual([])
    expect(live.state).toBe('off')
  })
})

describe('echo and noise filters', () => {
  it('treats words mostly from the spoken answer as echo', () => {
    expect(isEcho('the highest flood exposure', 'Houston has the highest flood exposure.')).toBe(true)
    expect(isEcho('what about Denver winter', 'Houston has the highest flood exposure.')).toBe(false)
  })
  it('drops coughs and fillers', () => {
    expect(isQuestion('um')).toBe(false)
    expect(isQuestion('')).toBe(false)
    expect(isQuestion('Denver?')).toBe(true)
    expect(isQuestion('rank hubs')).toBe(true)
  })
})

// ---------- web sources ----------

const WEB: WebSearchResult = {
  query: 'Port of Houston closure',
  results: [
    { title: 'Port Houston terminal status', url: 'https://porthouston.com/status', snippet: '12 ships at anchor.', published: '2026-11-16' },
    { title: 'Bad link', url: 'javascript:alert(1)', snippet: 'x', published: null },
  ],
  searched_at: '2026-11-17T22:00:00Z',
  note: 'From the web, not from our scoring data.',
}

describe('web sources', () => {
  it('lists linked sources labeled as web content', () => {
    render(<WebSources data={WEB} />)
    const region = screen.getByRole('region', { name: 'Web sources' })
    expect(region).toHaveTextContent(WEB_LABEL)
    const link = screen.getByRole('link', { name: /Port Houston terminal status/ })
    expect(link).toHaveAttribute('href', 'https://porthouston.com/status')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link.getAttribute('rel')).toContain('noopener')
    // a non-http URL is shown as text, never as a link
    expect(screen.queryByRole('link', { name: /Bad link/ })).toBeNull()
    expect(screen.getByText('Bad link')).toBeInTheDocument()
  })

  it('renders nothing without results', () => {
    const { container } = render(<WebSources data={{ ...WEB, results: [] }} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('marks web figures in the figures table with a link to the source', () => {
    const fig: Figure = { hub_id: 'houston', label: 'ships at anchor', value: 12, unit: 'ships', source_tool: 'web_search', source_field: 'https://porthouston.com/status', family: null }
    const score: Figure = { hub_id: 'houston', label: 'flood days', value: 5.9, unit: 'days', source_tool: 'get_hub_risk', source_field: 'days_per_year', family: 'flood' }
    render(<FiguresTable figures={[fig, score]} verified />)
    expect(screen.getAllByText(WEB_LABEL)).toHaveLength(1)
    expect(screen.getByRole('link', { name: `${WEB_LABEL}: open source` })).toHaveAttribute('href', 'https://porthouston.com/status')
  })

  it('has its own step label', () => {
    expect(toolLabel('web_search', { query: 'Houston port fog' }, false)).toBe('Searching the web: Houston port fog')
    expect(toolLabel('web_search', { query: 'Houston port fog' }, true)).toBe('Searched the web: Houston port fog')
  })
})

describe('LiveVoice audio, mute and levels', () => {
  function meter() {
    return { mic: vi.fn(), speaker: vi.fn(), read: vi.fn((src: string, n: number) => Array(n).fill(src === 'mic' ? 0.5 : 0.7)), resume: vi.fn(), close: vi.fn() }
  }

  it('measures the mic while listening and the answer while speaking, with one audio element per session', async () => {
    const f = fakes()
    const m = meter()
    const created = vi.fn(() => f.audio as unknown as HTMLAudioElement)
    const live = new LiveVoice(() => {}, { ...f.deps, createAudio: created, createMeter: () => m })
    await live.start()
    expect(m.mic).toHaveBeenCalled()
    expect(live.levels(4)).toEqual([0.5, 0.5, 0.5, 0.5])
    live.answered('t1', 'one')
    expect(live.levels(2)).toEqual([0.7, 0.7])
    live.skip()
    live.answered('t2', 'two')
    expect(created).toHaveBeenCalledTimes(1) // Web Audio can attach to an element only once
    expect(m.speaker).toHaveBeenCalledTimes(1)
    expect(f.audio.src).toBe('/voice/speak?trace_id=t2')
    live.stop()
    expect(m.close).toHaveBeenCalled()
    expect(live.levels(2)).toBeNull()
  })

  it('a skipped answer cannot end the next one early', async () => {
    const f = fakes()
    const live = new LiveVoice(() => {}, f.deps)
    await live.start()
    live.answered('t1', 'one')
    const firstEnded = f.audio.onended
    live.skip()
    live.answered('t2', 'two')
    firstEnded?.call(f.audio as never)
    expect(live.state).toBe('speaking')
  })

  it('mute silences the microphone track and unmute restores it', async () => {
    const f = fakes()
    const live = new LiveVoice(() => {}, f.deps)
    await live.start()
    live.toggleMute()
    expect(live.muted).toBe(true)
    expect(f.track.enabled).toBe(false)
    expect(live.levels(4)).toBeNull()
    live.toggleMute()
    expect(f.track.enabled).toBe(true)
    live.stop()
    expect(live.muted).toBe(false)
  })

  it('turns analyser bins into symmetric bars in 0..1', () => {
    const bars = barsFromBins(Array.from({ length: 128 }, (_, i) => (i < 8 ? 255 : 0)), 36)
    expect(bars).toHaveLength(36)
    expect(Math.max(...bars)).toBeLessThanOrEqual(1)
    expect(bars[17]).toBeGreaterThan(bars[0]) // loud low bins sit in the middle
    expect(bars.slice(0, 18)).toEqual([...bars.slice(18)].reverse())
  })
})
