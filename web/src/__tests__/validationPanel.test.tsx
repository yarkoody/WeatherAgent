// Developer mode "Validation details": figures with source tool and field, grounding status, tools, turn usage.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { AssistantMessage } from '../components/AssistantMessage'
import { ValidationPanel, errorsFor, resultSize } from '../components/ValidationPanel'
import type { ToolPartView } from '../components/ai-elements/tool-steps'
import { DebugProvider } from '../lib/debug'
import type { ChatResponse } from '../lib/types'
import { sseEvents } from './fixtures'

function turn(file: string): { message: UIMessage; response: ChatResponse; tools: ToolPartView[] } {
  const events = sseEvents(file)
  const response = events.find((e) => e.type === 'data-answer')!.data as ChatResponse
  const inputs = events.filter((e) => e.type === 'tool-input-available')
  const outputs = events.filter((e) => e.type === 'tool-output-available')
  const parts = inputs.map((i) => ({
    type: `tool-${i.toolName}`,
    toolCallId: i.toolCallId,
    state: 'output-available',
    input: i.input,
    output: outputs.find((o) => o.toolCallId === i.toolCallId)?.output,
  }))
  const tools = inputs.map((i) => ({
    toolCallId: i.toolCallId as string,
    name: i.toolName as string,
    state: 'output-available',
    input: i.input,
    output: outputs.find((o) => o.toolCallId === i.toolCallId)?.output,
  })) as ToolPartView[]
  const message: UIMessage = { id: 'a1', role: 'assistant', parts: [...parts, { type: 'data-answer', data: response }] as UIMessage['parts'] }
  return { message, response, tools }
}

const usage = { latency_ms: 2412.6, input_tokens: 18234, output_tokens: 412, cost_usd: 0.0123, tool_calls: 2 }

describe('Validation details', () => {
  it('shows only in developer mode, expanded under a finished answer', () => {
    const { message } = turn('chat-stream.sse')
    const { unmount } = render(
      <DebugProvider debug={false}>
        <AssistantMessage message={message} streaming={false} />
      </DebugProvider>,
    )
    expect(screen.queryByRole('region', { name: 'Validation details' })).not.toBeInTheDocument()
    unmount()
    render(
      <DebugProvider debug>
        <AssistantMessage message={message} streaming={false} />
      </DebugProvider>,
    )
    expect(screen.getByRole('region', { name: 'Validation details' })).toBeVisible()
  })

  it('one row per figure: hub, label, value and unit, source tool and field, and a check on a passing answer', () => {
    const { response, tools } = turn('chat-stream-compare.sse')
    render(<ValidationPanel response={response} tools={tools} />)
    const rows = within(screen.getByRole('list', { name: 'Figures and their sources' })).getAllByRole('listitem')
    expect(rows).toHaveLength(response.answer.figures.length)
    response.answer.figures.forEach((f, i) => {
      const path = f.family ? `families.${f.family}.${f.source_field}` : f.source_field
      expect(rows[i]).toHaveTextContent(`${f.label}`)
      expect(rows[i]).toHaveTextContent(`← ${f.source_tool} → ${path}`)
      expect(within(rows[i]).getByLabelText('validated')).toBeInTheDocument()
    })
    expect(screen.getByTestId('validation-status')).toHaveTextContent('Grounding passed first try.')
  })

  it('a failed check shows the error next to the affected figure and marks it', () => {
    const { response, tools } = turn('chat-stream-failed.sse')
    render(<ValidationPanel response={response} tools={tools} />)
    expect(screen.getByTestId('validation-status')).toHaveTextContent('Grounding failed.')
    for (const e of response.grounding.errors) expect(screen.getByText(e)).toBeInTheDocument()
    expect(screen.getAllByLabelText('not validated').length).toBeGreaterThan(0)
    expect(errorsFor({ hub_id: 'houston', label: 'exposure', value: 43, unit: '%', source_tool: 'get_hub_risk' }, ["Figure 'exposure' cites x"])).toEqual(["Figure 'exposure' cites x"])
  })

  it('tools in order with compact arguments and result size', () => {
    const { response, tools } = turn('chat-stream.sse')
    render(<ValidationPanel response={response} tools={tools} />)
    const rows = within(screen.getByRole('list', { name: 'Tool calls' })).getAllByRole('listitem')
    expect(rows).toHaveLength(tools.length)
    tools.forEach((t, i) => {
      expect(rows[i]).toHaveTextContent(t.name)
      expect(rows[i]).toHaveTextContent(resultSize(t.output))
    })
    expect(resultSize({ a: 1 })).toBe('7 B')
  })

  it('turn: trace id with a copy button, and usage rows (null rows hidden)', async () => {
    const { response, tools } = turn('chat-stream.sse')
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const { unmount } = render(<ValidationPanel response={{ ...response, usage }} tools={tools} />)
    const turnList = screen.getByLabelText('Turn')
    expect(turnList).toHaveTextContent(response.trace_id)
    expect(turnList).toHaveTextContent('Latency2.41 s')
    expect(turnList).toHaveTextContent('Input tokens18,234')
    expect(turnList).toHaveTextContent('Output tokens412')
    expect(turnList).toHaveTextContent('Estimated cost$0.0123')
    expect(turnList).toHaveTextContent('Tool calls2')
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Copy trace id' })))
    expect(writeText).toHaveBeenCalledWith(response.trace_id)
    unmount()

    render(<ValidationPanel response={{ ...response, usage: { ...usage, cost_usd: null } }} tools={tools} />)
    expect(screen.getByLabelText('Turn')).not.toHaveTextContent('Estimated cost')
    expect(screen.getByLabelText('Turn')).toHaveTextContent('Tool calls2')
    vi.unstubAllGlobals()
  })

  it('no usage at all: only the trace id', () => {
    const { response, tools } = turn('chat-stream.sse')
    render(<ValidationPanel response={{ ...response, usage: null }} tools={tools} />)
    expect(document.querySelectorAll('[data-usage-row]')).toHaveLength(0)
    expect(screen.getByLabelText('Turn')).toHaveTextContent(response.trace_id)
  })
})
