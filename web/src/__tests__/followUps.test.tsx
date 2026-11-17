// "Ask next" follow-up chips from ChatResponse.follow_ups, on the latest answer only.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../components/ChatView'
import { replayStream, withFreshMessageId } from '../lib/mockFetch'
import { saveMessages } from '../lib/session'
import type { ChatResponse } from '../lib/types'
import { readMock, sseEvents } from './fixtures'

const answer = sseEvents('chat-stream.sse').find((e) => e.type === 'data-answer')!.data as ChatResponse

/** First request replays the recorded turn; later ones stay open (still streaming) unless `finish` is set. */
function serve({ finishLater = false } = {}) {
  const bodies: { messages: UIMessage[] }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      const body = bodies.length === 1 || finishLater ? replayStream(withFreshMessageId(readMock('chat-stream.sse')), null, 0) : new ReadableStream({ start() {} })
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    }),
  )
  return bodies
}

const textOf = (m: UIMessage) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

async function askFirst() {
  render(<ChatView sessionId={`s-${Math.random()}`} speakAnswers={false} />)
  fireEvent.click(screen.getByRole('button', { name: /Midwest hubs/ }))
  return screen.findByRole('group', { name: 'Ask next' })
}

beforeEach(() => {
  vi.stubEnv('VITE_USE_MOCKS', '')
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Ask next', () => {
  it('renders the follow-ups from the data-answer part as buttons', async () => {
    serve()
    const group = await askFirst()
    expect(answer.follow_ups?.length).toBeGreaterThan(0)
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(answer.follow_ups)
  })

  it('clicking one sends its text as the next user message, and the chips hide while it streams', async () => {
    const bodies = serve()
    const group = await askFirst()
    const chip = within(group).getByRole('button', { name: answer.follow_ups![0] })
    chip.focus()
    expect(chip).toHaveFocus()
    fireEvent.click(chip)
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(textOf(bodies[1].messages[0])).toBe(answer.follow_ups![0])
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Ask next' })).not.toBeInTheDocument())
  })

  it('shows chips on the latest answer only', async () => {
    serve({ finishLater: true })
    const group = await askFirst()
    fireEvent.click(within(group).getByRole('button', { name: answer.follow_ups![1] }))
    await waitFor(() => expect(screen.getAllByLabelText('Answer')).toHaveLength(2))
    await waitFor(() => expect(screen.getAllByRole('group', { name: 'Ask next' })).toHaveLength(1))
  })

  it('shows nothing for an answer saved before follow-ups existed', () => {
    const { follow_ups: _drop, ...old } = answer
    saveMessages('old', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Rank hubs' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'data-answer', data: old } as UIMessage['parts'][number]] },
    ])
    render(<ChatView sessionId="old" speakAnswers={false} />)
    expect(screen.getByLabelText('Answer')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Ask next' })).not.toBeInTheDocument()
  })
})
