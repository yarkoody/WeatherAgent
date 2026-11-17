// A city resolved to a hub through its metro area ("New York" -> Newark) is said once, above the answer.
import { render, screen } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { AssistantMessage, resolutionNotes } from '../components/AssistantMessage'
import { sseEvents } from './fixtures'

/** The assistant message the AI SDK would build from a recorded stream (tool part + data-answer). */
function messageFrom(stream: string): UIMessage {
  const events = sseEvents(stream)
  const input = events.find((e) => e.type === 'tool-input-available')!
  const output = events.find((e) => e.type === 'tool-output-available')!
  const answer = events.find((e) => e.type === 'data-answer')!
  return {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: `tool-${input.toolName}`, toolCallId: input.toolCallId, state: 'output-available', input: input.input, output: output.output },
      { type: 'data-answer', data: answer.data },
    ] as UIMessage['parts'],
  }
}

describe('resolution notes', () => {
  it('shows the tool note once, above the answer card', () => {
    const message = messageFrom('chat-stream-resolution.sse')
    const notes = resolutionNotes(message)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatch(/^Resolved 'New York' to the Newark Hub \(Newark, NJ\)/)

    render(<AssistantMessage message={message} streaming={false} />)
    const note = screen.getByRole('note', { name: 'How the hub was chosen' })
    expect(note).toHaveTextContent(notes[0])
    const answer = screen.getByLabelText('Answer')
    expect(note.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('shows nothing when no name needed resolving', () => {
    render(<AssistantMessage message={messageFrom('chat-stream-weather.sse')} streaming={false} />)
    expect(screen.queryByRole('note', { name: 'How the hub was chosen' })).not.toBeInTheDocument()
  })
})
