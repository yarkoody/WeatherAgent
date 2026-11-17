const MOCKS = import.meta.glob<string>('../mocks/*.sse', { query: '?raw', import: 'default', eager: true })

export function readMock(name: string): string {
  const raw = MOCKS[`../mocks/${name}`]
  if (raw === undefined) throw new Error(`no mock stream ${name}`)
  return raw
}

/** JSON events of a recorded SSE stream, without the [DONE] sentinel. */
export function sseEvents(name: string): Record<string, unknown>[] {
  return readMock(name)
    .split('\n\n')
    .map((e) => e.trim())
    .filter((e) => e.startsWith('data: ') && e !== 'data: [DONE]')
    .map((e) => JSON.parse(e.slice(6)))
}

export function toolOutput(stream: string, toolName: string): unknown {
  const events = sseEvents(stream)
  const input = events.find((e) => e.type === 'tool-input-available' && e.toolName === toolName)
  const output = events.find((e) => e.type === 'tool-output-available' && e.toolCallId === input?.toolCallId)
  if (!output) throw new Error(`no ${toolName} output in ${stream}`)
  return output.output
}
