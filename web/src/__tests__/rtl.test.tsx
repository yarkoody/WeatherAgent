// Hebrew (and other right-to-left) chats read right to left; English chats render exactly as before.
import { render, screen, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatView } from '../components/ChatView'
import { textDir } from '../lib/textDir'
import { saveMessages } from '../lib/session'
import type { ChatResponse } from '../lib/types'
import { sseEvents } from './fixtures'

const english = sseEvents('chat-stream.sse').find((e) => e.type === 'data-answer')!.data as ChatResponse

const HE_Q = 'איזה מרכז הכי חשוף לחורף?'
const hebrew: ChatResponse = {
  ...english,
  answer: {
    ...english.answer,
    answer: '**Chicago** הוא המרכז החשוף ביותר לחורף.\n\n- ציון 72 מתוך 100\n- Denver במקום השני',
    assumptions: ['החודשים דצמבר עד פברואר'],
    uncertainty: 'הנתונים מכסים את 2015 עד 2025.',
  },
  follow_ups: ['איך משווים את Chicago ו-Denver?'],
}

function restore(id: string, question: string, response: ChatResponse) {
  saveMessages(id, [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: question }] },
    { id: 'a1', role: 'assistant', parts: [{ type: 'data-answer', data: response } as UIMessage['parts'][number]] },
  ])
  render(<ChatView sessionId={id} />)
}

beforeEach(() => {
  vi.stubEnv('VITE_USE_MOCKS', '')
  localStorage.clear()
})
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('textDir', () => {
  it('is rtl for Hebrew, also when it opens with an English hub name, and unset otherwise', () => {
    expect(textDir(HE_Q)).toBe('rtl')
    expect(textDir('**Chicago** הוא המרכז החשוף ביותר לחורף.')).toBe('rtl')
    expect(textDir('ما هو المركز الأكثر عرضة؟')).toBe('rtl')
    expect(textDir('Which Midwest hubs are most exposed to winter weather?')).toBeUndefined()
    expect(textDir('Is Tel Aviv (תל אביב) covered?')).toBeUndefined()
    expect(textDir('72%')).toBeUndefined()
    expect(textDir('')).toBeUndefined()
  })
})

describe('right-to-left chats', () => {
  it('a Hebrew question and answer read right to left; the figures stay left to right', () => {
    restore('he', HE_Q, hebrew)
    expect(screen.getByText(HE_Q)).toHaveAttribute('dir', 'rtl')
    const card = screen.getByLabelText('Answer')
    const prose = card.querySelector('.prose-answer')!
    expect(prose).toHaveAttribute('dir', 'rtl')
    expect(prose).toHaveClass('ml-auto')
    expect(within(card).getByText('החודשים דצמבר עד פברואר').closest('ul')).toHaveAttribute('dir', 'rtl')
    expect(within(card).getByText('הנתונים מכסים את 2015 עד 2025.')).toHaveAttribute('dir', 'rtl')
    const chip = within(screen.getByRole('group', { name: 'Ask next' })).getByRole('button')
    expect(chip).toHaveAttribute('dir', 'rtl')
    // The English labels around the answer keep the page direction.
    expect(within(card).getByText(/Assumptions/).closest('[dir]')).toBe(null)
  })

  it('an English chat renders as before: no dir attributes, no extra classes', () => {
    restore('en', 'Which Midwest hubs are most exposed to winter weather?', english)
    expect(screen.getByText('Which Midwest hubs are most exposed to winter weather?')).not.toHaveAttribute('dir')
    const card = screen.getByLabelText('Answer')
    expect(card.querySelectorAll('[dir]')).toHaveLength(0)
    expect(card.querySelector('.prose-answer')!.className).toBe('prose-answer max-w-[68ch] text-[0.95rem] text-ink')
    for (const chip of within(screen.getByRole('group', { name: 'Ask next' })).getAllByRole('button')) expect(chip).not.toHaveAttribute('dir')
  })

  it('the composer follows what is typed', () => {
    render(<ChatView sessionId="empty" />)
    expect(screen.getByLabelText('Ask about hub weather risk')).toHaveAttribute('dir', 'auto')
  })
})
