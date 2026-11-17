// Live voice: the Live button and status states, the session state machine (fake WebRTC), and the web sources display.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Composer } from '../components/Composer'
import { FiguresTable } from '../components/FiguresTable'
import { LIVE_STATE_TEXT, LiveButton, LiveStatus, type LiveView } from '../components/LiveControls'
import { LiveVoice, UNSUPPORTED_HINT, isEcho, isQuestion, type LiveDeps, type LiveState } from '../lib/liveVoice'
import { toolLabel } from '../lib/toolLabels'
import { WEB_LABEL, type Figure, type WebSearchResult } from '../lib/types'
import { WebSources } from '../widgets/WebSources'

function view(state: LiveState, patch: Partial<LiveView> = {}): LiveView {
  return { supported: true, state, error: null, hint: null, interim: '', start: vi.fn(), stop: vi.fn(), skip: vi.fn(), ...patch }
}

describe('Live button and status', () => {
  it('starts live voice from the composer when off', () => {
    const live = view('off')
    render(<Composer busy={false} onSend={() => {}} onStop={() => {}} live={live} />)
    fireEvent.click(screen.getByRole('button', { name: 'Start live voice' }))
    expect(live.start).toHaveBeenCalled()
    expect(screen.queryByTestId('live-status')).toBeNull()
  })

  it.each(['connecting', 'listening', 'thinking', 'speaking'] as LiveState[])('shows the %s state with a Stop button', (state) => {
    const live = view(state)
    render(<Composer busy={false} onSend={() => {}} onStop={() => {}} live={live} />)
    expect(screen.getByTestId('live-status')).toHaveAttribute('data-state', state)
    expect(screen.getByTestId('live-status')).toHaveTextContent(LIVE_STATE_TEXT[state])
    const stop = screen.getByRole('button', { name: 'Stop live voice' })
    expect(stop).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(stop)
    expect(live.stop).toHaveBeenCalled()
  })

  it('offers Skip only while speaking, and shows what it heard', () => {
    const live = view('speaking', { interim: 'which hub' })
    render(<LiveStatus live={live} />)
    expect(screen.getByText('“which hub”')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /skip/i }))
    expect(live.skip).toHaveBeenCalled()
    render(<LiveStatus live={view('listening')} />)
    expect(screen.getAllByRole('button', { name: /skip/i })).toHaveLength(1)
  })

  it('shows the fallback message outside Chrome and Edge', () => {
    const live = view('off', { supported: false })
    render(<LiveButton live={live} />)
    const button = screen.getByRole('button', { name: `Live voice: ${UNSUPPORTED_HINT}` })
    expect(button).toHaveAttribute('aria-disabled', 'true')
    fireEvent.click(button)
    expect(live.start).not.toHaveBeenCalled()
  })

  it('shows why a session ended after it stops', () => {
    render(<LiveStatus live={view('off', { error: 'The daily live-voice cap for this demo has been reached.' })} />)
    expect(screen.getByRole('alert')).toHaveTextContent('daily live-voice cap')
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
  const track = { stop: vi.fn() }
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
