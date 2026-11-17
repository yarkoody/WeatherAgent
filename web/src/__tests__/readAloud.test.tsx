// Read aloud per answer (replaces the global speaker toggle), and the header / sidebar layout around it.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { ChatView } from '../components/ChatView'
import { saveChatMessages } from '../lib/chats'
import type { ChatResponse } from '../lib/types'
import { answerSpeech } from '../lib/voice'
import { sseEvents } from './fixtures'

const answerOf = (stream: string) => sseEvents(stream).find((e) => e.type === 'data-answer')!.data as ChatResponse
const verified = answerOf('chat-stream.sse')
const failed = answerOf('chat-stream-failed.sse')

function turn(n: number, question: string, answer: ChatResponse): UIMessage[] {
  return [
    { id: `u${n}`, role: 'user', parts: [{ type: 'text', text: question }] },
    { id: `a${n}`, role: 'assistant', parts: [{ type: 'data-answer', data: answer }] as UIMessage['parts'] },
  ]
}

interface FakeUtterance {
  text: string
  onend: (() => void) | null
  onerror: (() => void) | null
}

/** Speech synthesis stub that behaves like browsers: cancel() ends the current utterance. */
function speech() {
  const spoken: FakeUtterance[] = []
  let current: FakeUtterance | null = null
  const synth = {
    speak: vi.fn((u: FakeUtterance) => {
      spoken.push(u)
      current = u
    }),
    cancel: vi.fn(() => {
      const u = current
      current = null
      u?.onend?.()
    }),
  }
  vi.stubGlobal('speechSynthesis', synth)
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      lang = ''
      onend = null
      onerror = null
      constructor(public text: string) {}
    },
  )
  return { synth, spoken, finish: () => current?.onend?.() }
}

beforeEach(() => {
  localStorage.clear()
  saveChatMessages('c', [...turn(1, 'Rank hubs', verified), ...turn(2, 'How exposed is Houston?', failed)])
})
afterEach(() => vi.unstubAllGlobals())

describe('read aloud', () => {
  it('each answer has its own button that reads only that answer', () => {
    const { synth, spoken } = speech()
    render(<ChatView sessionId="c" />)
    const buttons = screen.getAllByRole('button', { name: 'Read aloud' })
    expect(buttons).toHaveLength(2)

    fireEvent.click(buttons[0])
    expect(synth.speak).toHaveBeenCalledTimes(1)
    expect(spoken[0].text).toBe(answerSpeech(verified))
    expect(screen.getAllByRole('button', { name: 'Stop reading' })).toHaveLength(1)
  })

  it('starting another answer stops the first, and failed answers are flagged', () => {
    const { synth, spoken } = speech()
    render(<ChatView sessionId="c" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Read aloud' })[0])
    fireEvent.click(screen.getAllByRole('button', { name: 'Read aloud' })[0]) // now the second answer's button
    expect(synth.cancel).toHaveBeenCalled()
    expect(spoken[1].text).toMatch(/^Unverified answer\. /)
    const stops = screen.getAllByRole('button', { name: 'Stop reading' })
    expect(stops).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /Read aloud|Stop reading/ }).indexOf(stops[0])).toBe(1)
  })

  it('Stop ends it, and the button resets when speech finishes on its own', () => {
    const { synth, finish } = speech()
    render(<ChatView sessionId="c" />)
    fireEvent.click(screen.getAllByRole('button', { name: 'Read aloud' })[0])
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }))
    expect(synth.cancel).toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Stop reading' })).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByRole('button', { name: 'Read aloud' })[1])
    expect(screen.getByRole('button', { name: 'Stop reading' })).toBeInTheDocument()
    act(() => finish()) // the browser ends the utterance
    expect(noStopButton()).toBe(true)
  })

  it('is hidden when the browser cannot speak', () => {
    vi.stubGlobal('speechSynthesis', undefined)
    render(<ChatView sessionId="c" />)
    expect(screen.queryByRole('button', { name: 'Read aloud' })).not.toBeInTheDocument()
  })
})

function noStopButton() {
  return screen.queryByRole('button', { name: 'Stop reading' }) === null
}

describe('header and sidebar', () => {
  it('has no global speaker toggle, the hamburger comes first, and Settings lives in the sidebar', () => {
    speech()
    render(<App />)
    const header = screen.getByRole('banner')
    expect(within(header).queryByRole('button', { name: /answers aloud/i })).not.toBeInTheDocument()
    expect(within(header).getAllByRole('button')[0]).toHaveAccessibleName('Close chat history')
    expect(within(header).queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
    const nav = screen.getByRole('navigation', { name: 'Chat history' })
    expect(within(nav).getByRole('button', { name: 'Settings' })).toBeInTheDocument()
    expect(within(nav).getByText('Chats are saved in this browser only.')).toBeInTheDocument()
  })
})
