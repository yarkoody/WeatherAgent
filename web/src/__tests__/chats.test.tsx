// Chat history: the localStorage store and the sidebar (create, switch, rename, delete, restore, corrupt storage).
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { CHATS_KEY, MAX_CHATS, deleteChat, groupChats, loadChats, renameChat, saveChatMessages, titleFrom } from '../lib/chats'
import { replayStream, withFreshMessageId } from '../lib/mockFetch'
import { readMock } from './fixtures'

const user = (id: string, text: string): UIMessage => ({ id, role: 'user', parts: [{ type: 'text', text }] })
const DAY = 86_400_000

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('chat store', () => {
  it('titles a chat from its first question, trimmed to about 40 characters', () => {
    expect(titleFrom([user('u1', 'Which Midwest hubs are most exposed to winter weather?')])).toBe('Which Midwest hubs are most exposed to…')
    expect(titleFrom([user('u1', 'Rank hubs')])).toBe('Rank hubs')
    expect(titleFrom([])).toBe('New chat')
  })

  it('creates, renames and deletes chats, and the data survives a reload', () => {
    saveChatMessages('a', [user('u1', 'Rank hubs')])
    saveChatMessages('b', [user('u2', 'Compare Houston and Dallas')])
    expect(loadChats().map((c) => c.id)).toEqual(['b', 'a']) // most recent first

    renameChat('a', 'Winter check')
    saveChatMessages('a', [user('u1', 'Rank hubs'), user('u3', 'And priority?')])
    expect(loadChats().find((c) => c.id === 'a')!.title).toBe('Winter check') // a rename sticks

    // "reload": everything is read back from localStorage
    const raw = JSON.parse(localStorage.getItem(CHATS_KEY)!)
    expect(raw.version).toBe(1)
    expect(loadChats().find((c) => c.id === 'a')!.messages).toHaveLength(2)

    deleteChat('b')
    expect(loadChats().map((c) => c.id)).toEqual(['a'])
  })

  it(`keeps at most ${MAX_CHATS} chats, dropping the oldest`, () => {
    for (let i = 0; i < MAX_CHATS + 3; i++) saveChatMessages(`c${i}`, [user(`u${i}`, `Question ${i}`)], 1_000 + i)
    const ids = loadChats().map((c) => c.id)
    expect(ids).toHaveLength(MAX_CHATS)
    expect(ids).not.toContain('c0')
    expect(ids[0]).toBe(`c${MAX_CHATS + 2}`)
  })

  it('survives corrupt storage and drops malformed chats', () => {
    localStorage.setItem(CHATS_KEY, '{not json')
    expect(loadChats()).toEqual([])
    saveChatMessages('ok', [user('u1', 'Rank hubs')])
    expect(loadChats().map((c) => c.id)).toEqual(['ok'])

    localStorage.setItem(CHATS_KEY, JSON.stringify({ version: 1, chats: [{ id: 'x' }, null, { id: 'y', title: 'T', createdAt: 1, updatedAt: 1, messages: [{ bad: 1 }] }] }))
    const chats = loadChats()
    expect(chats.map((c) => c.id)).toEqual(['y'])
    expect(chats[0].messages).toEqual([])
  })

  it('groups chats by Today, Yesterday and Earlier', () => {
    const now = new Date('2026-11-17T15:00:00').getTime()
    const at = (t: number) => ({ id: String(t), title: 't', createdAt: t, updatedAt: t, messages: [] })
    const groups = groupChats([at(now - 1000), at(now - DAY), at(now - 5 * DAY)], now)
    expect(groups.map((g) => [g.label, g.chats.length])).toEqual([
      ['Today', 1],
      ['Yesterday', 1],
      ['Earlier', 1],
    ])
  })
})

describe('sidebar', () => {
  /** Every /chat request replays the recorded ranking turn; the bodies are kept for inspection. */
  function serve() {
    vi.stubEnv('VITE_USE_MOCKS', '')
    const bodies: { id: string; messages: UIMessage[] }[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url, 'http://test').pathname
        if (path !== '/chat') return Response.json({ detail: 'not found' }, { status: 404 })
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(replayStream(withFreshMessageId(readMock('chat-stream.sse')), null, 0), { headers: { 'Content-Type': 'text/event-stream' } })
      }),
    )
    return bodies
  }
  const history = () => screen.getByRole('navigation', { name: 'Chat history' })

  async function ask(text: string) {
    fireEvent.change(screen.getByLabelText('Ask about hub weather risk'), { target: { value: text } })
    fireEvent.submit(screen.getByLabelText('Ask about hub weather risk').closest('form')!)
    await waitFor(() => expect(within(history()).getByRole('button', { name: new RegExp(`^Open chat: ${text.slice(0, 20)}`) })).toBeInTheDocument())
  }

  it('creates, switches, renames and deletes chats, and sends the compact history', async () => {
    const bodies = serve()
    render(<App />)
    await ask('Rank the Midwest hubs')
    await screen.findByLabelText('Answer')

    // a follow-up in the same chat carries the earlier turn: user text and the answer only
    await ask('Rank the Midwest hubs')
    await waitFor(() => expect(bodies).toHaveLength(2))
    const sent = bodies[1].messages
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(sent[1].parts.map((p) => p.type)).toEqual(['data-answer'])
    expect(sent.flatMap((m) => m.parts).some((p) => p.type.startsWith('tool-'))).toBe(false)
    expect(bodies[0].id).toBe(bodies[1].id)

    // New chat keeps the old one
    fireEvent.click(within(history()).getByRole('button', { name: 'New chat' }))
    expect(await screen.findByText('Where will weather hit your network hardest?')).toBeInTheDocument()
    await ask('Compare Houston and Dallas')
    await waitFor(() => expect(bodies).toHaveLength(3))
    expect(bodies[2].id).not.toBe(bodies[0].id)
    expect(bodies[2].messages).toHaveLength(1)

    // switch back: the first chat's messages and answer card come back, and it continues with the same id
    await waitFor(() => expect(screen.getAllByLabelText('Answer')).toHaveLength(1))
    fireEvent.click(within(history()).getByRole('button', { name: /^Open chat: Rank the Midwest hubs/ }))
    await waitFor(() => expect(screen.getAllByLabelText('Answer')).toHaveLength(2))
    expect(within(history()).getByRole('button', { name: /^Open chat: Rank the Midwest hubs/ })).toHaveAttribute('aria-current', 'page')

    // rename
    fireEvent.click(within(history()).getByRole('button', { name: 'Rename Rank the Midwest hubs' }))
    const input = within(history()).getByRole('textbox', { name: 'Chat title' })
    fireEvent.change(input, { target: { value: 'Winter review' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(within(history()).getByRole('button', { name: /^Open chat: Winter review/ })).toBeInTheDocument()

    // delete asks first
    fireEvent.click(within(history()).getByRole('button', { name: 'Delete Compare Houston and Dallas' }))
    fireEvent.click(within(history()).getByRole('button', { name: 'Cancel' }))
    expect(within(history()).getByRole('button', { name: /^Open chat: Compare Houston/ })).toBeInTheDocument()
    fireEvent.click(within(history()).getByRole('button', { name: 'Delete Compare Houston and Dallas' }))
    fireEvent.click(within(history()).getByRole('button', { name: 'Delete' }))
    expect(within(history()).queryByRole('button', { name: /^Open chat: Compare Houston/ })).not.toBeInTheDocument()
    expect(loadChats().map((c) => c.title)).toEqual(['Winter review'])
    expect(within(history()).getByText('Chats are saved in this browser only.')).toBeInTheDocument()
  })

  it('restores the active chat after a reload', async () => {
    saveChatMessages('restored', [user('u1', 'Rank hubs')])
    localStorage.setItem('weather-risk.active_chat', 'restored')
    render(<App />)
    expect(within(history()).getByRole('button', { name: /^Open chat: Rank hubs/ })).toHaveAttribute('aria-current', 'page')
    expect(screen.getAllByText('Rank hubs').length).toBeGreaterThan(1) // in the list and in the thread
  })

  it('reopens the chat you were in after a reload, without picking it from the list', async () => {
    serve()
    const { unmount } = render(<App />)
    await ask('Rank the Midwest hubs')
    await screen.findByLabelText('Answer')
    unmount()
    render(<App />) // "reload"
    expect(screen.getByLabelText('Answer')).toBeInTheDocument()
    expect(within(history()).getByRole('button', { name: /^Open chat: Rank the Midwest hubs/ })).toHaveAttribute('aria-current', 'page')
  })

  it('starts cleanly when the stored chats are corrupt', () => {
    localStorage.setItem(CHATS_KEY, '{oops')
    render(<App />)
    expect(screen.getByText('Where will weather hit your network hardest?')).toBeInTheDocument()
    expect(within(history()).getByText('No chats yet.')).toBeInTheDocument()
  })
})

describe('sidebar toggle (hamburger)', () => {
  it('opens and closes the sidebar on desktop', () => {
    render(<App />)
    const toggle = screen.getByRole('button', { name: 'Close chat history' })
    expect(toggle.querySelector('svg.lucide-menu')).not.toBeNull()
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(toggle)
    expect(screen.queryByRole('navigation', { name: 'Chat history' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open chat history' })).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(screen.getByRole('button', { name: 'Open chat history' }))
    expect(screen.getByRole('navigation', { name: 'Chat history' })).toBeInTheDocument()
  })

  it('on small screens opens a slide-over that Escape closes, returning focus to the button', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-width: 767px)', addEventListener() {}, removeEventListener() {} }))
    render(<App />)
    const toggle = screen.getByRole('button', { name: 'Open chat history' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(toggle)
    const nav = await screen.findByRole('navigation', { name: 'Chat history' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(nav, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('navigation', { name: 'Chat history' })).not.toBeInTheDocument())
    await waitFor(() => expect(toggle).toHaveFocus())
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
  })
})

describe('New chat', () => {
  it('appears in the sidebar as soon as it is clicked, and takes its title from the first question', async () => {
    vi.stubEnv('VITE_USE_MOCKS', '')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(replayStream(withFreshMessageId(readMock('chat-stream.sse')), null, 0), { headers: { 'Content-Type': 'text/event-stream' } })),
    )
    saveChatMessages('old', [user('u1', 'Rank hubs')])
    localStorage.setItem('weather-risk.active_chat', 'old')
    render(<App />)
    const nav = () => screen.getByRole('navigation', { name: 'Chat history' })

    fireEvent.click(within(nav()).getByRole('button', { name: 'New chat' }))
    const fresh = within(nav()).getByRole('button', { name: 'Open chat: New chat' })
    expect(fresh).toHaveAttribute('aria-current', 'page')
    expect(within(nav()).getByRole('button', { name: /^Open chat: Rank hubs/ })).toBeInTheDocument()

    // a second click while the new chat is still empty does not add another one
    fireEvent.click(within(nav()).getByRole('button', { name: 'New chat' }))
    expect(within(nav()).getAllByRole('button', { name: 'Open chat: New chat' })).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Ask about hub weather risk'), { target: { value: 'Compare Houston and Dallas' } })
    fireEvent.submit(screen.getByLabelText('Ask about hub weather risk').closest('form')!)
    await waitFor(() => expect(within(nav()).getByRole('button', { name: /^Open chat: Compare Houston and Dallas/ })).toHaveAttribute('aria-current', 'page'))
    expect(within(nav()).queryByRole('button', { name: 'Open chat: New chat' })).not.toBeInTheDocument()
    expect(loadChats()).toHaveLength(2)
  })
})

describe('New chat title', () => {
  it('changes from "New chat" to the question as soon as it is sent, before the answer arrives', async () => {
    vi.stubEnv('VITE_USE_MOCKS', '')
    // the reply never finishes: the title must not wait for it
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } })))
    render(<App />)
    const nav = () => screen.getByRole('navigation', { name: 'Chat history' })
    fireEvent.click(within(nav()).getByRole('button', { name: 'New chat' }))
    expect(within(nav()).getByRole('button', { name: 'Open chat: New chat' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Ask about hub weather risk'), { target: { value: 'Which hubs flood most?' } })
    fireEvent.submit(screen.getByLabelText('Ask about hub weather risk').closest('form')!)
    await waitFor(() => expect(within(nav()).getByRole('button', { name: 'Open chat: Which hubs flood most?' })).toHaveAttribute('aria-current', 'page'))
    expect(screen.queryByLabelText('Answer')).not.toBeInTheDocument()
  })
})
