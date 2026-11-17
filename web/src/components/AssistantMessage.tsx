import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { ToolSteps, type ToolPartView } from '@/components/ai-elements/tool-steps'
import { Message, MessageContent } from '@/components/ui/message'
import type { ChatResponse } from '@/lib/types'
import { isToolError } from '@/lib/types'
import { WIDGETS } from '@/widgets'
import { AnswerCard, PendingAnswer } from './AnswerCard'

export function toolParts(message: UIMessage): ToolPartView[] {
  return message.parts.filter(isToolUIPart).map((p) => ({
    toolCallId: p.toolCallId,
    name: getToolName(p),
    state: p.state as ToolPartView['state'],
    input: (p.input ?? undefined) as Record<string, unknown> | undefined,
    output: 'output' in p ? p.output : undefined,
    errorText: 'errorText' in p ? (p.errorText as string | undefined) : undefined,
  }))
}

/** The single data-answer part: the grounding-verified ChatResponse. */
export function answerPart(message: UIMessage): ChatResponse | null {
  const part = message.parts.find((p) => p.type === 'data-answer') as { data: ChatResponse } | undefined
  return part?.data ?? null
}

/** The agent's turn: tool steps, the verified answer card, then one widget per tool output. */
export function AssistantMessage({ message, streaming }: { message: UIMessage; streaming: boolean }) {
  const tools = toolParts(message)
  const response = answerPart(message)
  const allDone = tools.every((t) => t.state === 'output-available' || t.state === 'output-error')
  const widgets = tools.filter((t) => t.state === 'output-available' && !isToolError(t.output) && WIDGETS[t.name as keyof typeof WIDGETS])

  return (
    <Message>
      <MessageContent className="gap-3 text-base">
        <ToolSteps tools={tools} thinking={streaming && !response && allDone} />
        {response ? <AnswerCard response={response} /> : streaming ? <PendingAnswer /> : null}
        {widgets.map((t) => {
          const Widget = WIDGETS[t.name as keyof typeof WIDGETS]!
          return <Widget key={t.toolCallId} data={t.output} />
        })}
      </MessageContent>
    </Message>
  )
}
