// Regression tests for the PR #2 review findings.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnswerCard } from '../components/AnswerCard'
import { AssistantMessage } from '../components/AssistantMessage'
import { ChatView } from '../components/ChatView'
import { citationText } from '../components/ai-elements/inline-citation'
import { FiguresTable } from '../components/FiguresTable'
import { describeChatError } from '../lib/chatErrors'
import { formatValue } from '../lib/format'
import { replayStream } from '../lib/mockFetch'
import { DebugProvider } from '../lib/debug'
import { loadMessages, saveMessages } from '../lib/session'
import type { ChatResponse, HubScore } from '../lib/types'
import { answerSpeech } from '../lib/voice'
import mock from '../mocks/chat-response.json'
import { HubBreakdown } from '../widgets/HubBreakdown'
import { readMock, sseEvents, toolOutput } from './fixtures'

const response = mock as ChatResponse
const failed: ChatResponse = { ...response, grounding: { status: 'failed', errors: ['43 is not in figures'] } }

/** Serve /chat from an SSE string (or an HTTP error) through the real AI SDK transport. */
function serveChat(reply: { sse?: string; status?: number; detail?: string }) {
  const bodies: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(String(init.body)) : null)
      if (reply.status) return Response.json({ detail: reply.detail }, { status: reply.status })
      return new Response(replayStream(reply.sse ?? '', null, 0), { headers: { 'Content-Type': 'text/event-stream' } })
    }),
  )
  return bodies
}

function toSse(events: Record<string, unknown>[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n'
}

async function ask(text = 'Which Midwest hubs are most exposed to winter weather?', debug = false) {
  render(
    <DebugProvider debug={debug}>
      <ChatView sessionId={`s-${Math.random()}`} speakAnswers={false} />
    </DebugProvider>,
  )
  fireEvent.change(screen.getByLabelText('Ask about hub weather risk'), { target: { value: text } })
  fireEvent.submit(screen.getByLabelText('Ask about hub weather risk').closest('form')!)
}

beforeEach(() => {
  vi.stubEnv('VITE_USE_MOCKS', '')
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('failed grounding (critical)', () => {
  it('marks every figure unverified and never claims a match', async () => {
    serveChat({ sse: readMock('chat-stream-failed.sse') })
    await ask('How exposed is Houston?', true) // developer view, where the source citations are shown
    await waitFor(() => expect(screen.getByLabelText('Answer')).toBeInTheDocument())
    expect(screen.getByText('Unverified')).toBeInTheDocument()
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row).toHaveAttribute('data-verified', 'false')
      expect(within(row).getByRole('button')).toHaveAccessibleName(/not verified/i)
    }
  })

  it('changes the citation text by grounding status', () => {
    const f = response.answer.figures[0]
    expect(citationText(f, true)).toMatch(/matched it to that tool's output/)
    expect(citationText(f, false)).toMatch(/could not be matched/i)
    expect(citationText(f, false)).not.toMatch(/matched it to/)
  })

  it('table rows default to verified', () => {
    render(<FiguresTable figures={response.answer.figures} verified />)
    expect(screen.getAllByRole('row')[1]).toHaveAttribute('data-verified', 'true')
  })
})

describe('read aloud', () => {
  it('prefixes failed answers and reads verified ones as is', () => {
    expect(answerSpeech(response)).toBe(response.answer.answer.replace(/\*\*/g, ''))
    expect(answerSpeech(failed)).toMatch(/^Unverified answer\. /)
  })
})

describe('HTTP errors from /chat', () => {
  it('429 shows the limit and offers no retry; only the last user message is sent', async () => {
    const bodies = serveChat({ status: 429, detail: 'Daily request cap reached. Try again tomorrow.' })
    await ask()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/limit/i)
    expect(alert).toHaveTextContent('Daily request cap reached')
    expect(within(alert).queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    const body = bodies[0] as { id: string; messages: UIMessage[] }
    expect(body.id).toBeTruthy()
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
  })

  it('maps 422, 503 and network errors', () => {
    const err = (status: number, detail: string) => new Error(JSON.stringify({ status, detail }))
    expect(describeChatError(err(422, 'message: too long'))).toMatchObject({ canRetry: false, detail: 'message: too long' })
    expect(describeChatError(err(503, 'The model is unavailable.'))).toMatchObject({ canRetry: true })
    expect(describeChatError(err(429, 'Too many requests'))).toMatchObject({ canRetry: false })
    expect(describeChatError(new Error('Failed to fetch'))).toMatchObject({ canRetry: true })
  })
})

describe('streams that end without an answer', () => {
  it('shows unfinished tools as stopped and a no-answer notice', async () => {
    const events = sseEvents('chat-stream.sse').filter((e) => e.type !== 'data-answer' && e.type !== 'tool-output-available')
    serveChat({ sse: toSse(events) })
    await ask()
    await screen.findByText(/No answer received/)
    expect(document.querySelector('[data-status="running"]')).toBeNull()
    expect(screen.getAllByText(/stopped/i).length).toBeGreaterThan(0)
  })

  it('renders an output-error tool part as a failed step without a widget', async () => {
    const events = sseEvents('chat-stream.sse').map((e) =>
      e.type === 'tool-output-available' ? { type: 'tool-output-error', toolCallId: e.toolCallId, errorText: 'upstream timeout' } : e,
    )
    serveChat({ sse: toSse(events) })
    await ask()
    await waitFor(() => expect(screen.getByLabelText('Answer')).toBeInTheDocument())
    expect(screen.getAllByText(/no result/).length).toBe(2)
    expect(screen.queryByLabelText('Ranking chart')).not.toBeInTheDocument()
  })
})

describe('restored history', () => {
  it('drops malformed entries instead of crashing', () => {
    localStorage.setItem('weather-risk.messages.bad', '{"not":"an array"}')
    expect(loadMessages('bad')).toEqual([])
    localStorage.setItem('weather-risk.messages.mixed', JSON.stringify([null, { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }, { id: 2 }]))
    expect(loadMessages('mixed').map((m) => m.id)).toEqual(['u1'])
    localStorage.setItem('weather-risk.messages.junk', 'not json')
    expect(loadMessages('junk')).toEqual([])
  })

  it('does not restore spinners for a turn that never finished', () => {
    const half: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [{ type: 'tool-rank_hubs', toolCallId: 't1', state: 'input-available', input: { score: 'exposure' } } as UIMessage['parts'][number]],
    }
    saveMessages('restored', [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Rank hubs' }] }, half])
    render(<ChatView sessionId="restored" speakAnswers={false} />)
    expect(document.querySelector('[data-status="running"]')).toBeNull()
    expect(screen.getByText(/No answer received/)).toBeInTheDocument()
  })
})

describe('stopped before the first chunk', () => {
  it('a question with no reply gets the no-answer notice', () => {
    saveMessages('orphan', [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Rank hubs' }] }])
    render(<ChatView sessionId="orphan" speakAnswers={false} />)
    expect(screen.getByText(/No answer received/)).toBeInTheDocument()
  })
})

describe('error boundaries', () => {
  it('a widget that throws on bad tool data does not take the answer down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'tool-rank_hubs', toolCallId: 't1', state: 'output-available', input: {}, output: { kind: 'exposure' } } as UIMessage['parts'][number],
        { type: 'data-answer', data: response } as UIMessage['parts'][number],
      ],
    }
    render(<AssistantMessage message={message} streaming={false} />)
    expect(screen.getByLabelText('Answer')).toBeInTheDocument()
    expect(await screen.findByText(/could not be drawn/i)).toBeInTheDocument()
  })
})

describe('hub breakdown thresholds', () => {
  it('uses the day cut-offs from band_thresholds', () => {
    const hub = toolOutput('chat-stream.sse', 'get_hub_risk') as HubScore
    const custom: HubScore = { ...hub, band_thresholds: { ...hub.band_thresholds, medium_from_days: 7.5, high_from_days: 12.25 } }
    render(<HubBreakdown data={custom} />)
    expect(screen.getByText(/medium band from 7\.5 days, high from 12\.25 days/)).toBeInTheDocument()
  })
})

describe('answer markdown safety and states', () => {
  it('does not load images and opens links in a new tab', () => {
    const text = 'See ![pixel](https://evil.example/p.png) and [the source](https://example.com).'
    render(<AnswerCard response={{ ...response, answer: { ...response.answer, answer: text } }} />)
    expect(document.querySelector('img')).toBeNull()
    const link = screen.getByRole('link', { name: 'the source' })
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('a failed answer with no figures says it could not answer', () => {
    const fallback: ChatResponse = {
      ...failed,
      answer: { ...response.answer, figures: [], data_available: false, answer: 'I could not produce a verified answer.' },
    }
    render(<AnswerCard response={fallback} />)
    expect(screen.getByLabelText('Answer')).toHaveAttribute('data-kind', 'could_not_answer')
    expect(screen.getByText('Could not answer')).toBeInTheDocument()
    expect(screen.queryByText('No data for this question')).not.toBeInTheDocument()
  })

  it('shows figure values with their given precision', () => {
    expect(formatValue(0.125, 'score 0-100')).toBe('0.125')
    expect(formatValue(8.75, 'days')).toBe('8.75 days')
    expect(formatValue(11.8, '%')).toBe('11.8%')
  })
})
