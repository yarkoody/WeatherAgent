import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { CircleSlashIcon } from 'lucide-react'
import { Suspense } from 'react'
import { Skeleton } from '@/components/ui/skeleton'
import { ToolSteps, type ToolPartView } from '@/components/ai-elements/tool-steps'
import { ErrorBoundary, WidgetFallback } from '@/components/ErrorBoundary'
import { Message, MessageContent } from '@/components/ui/message'
import type { ChatResponse } from '@/lib/types'
import { isToolError } from '@/lib/types'
import { WIDGETS } from '@/widgets'
import { AnswerCard, PendingAnswer } from './AnswerCard'

const SMALL = new Set(['weather_stat', 'get_active_alerts'])

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
  const widgets = tools.filter(
    (t) =>
      t.state === 'output-available' &&
      !isToolError(t.output) &&
      WIDGETS[t.name as keyof typeof WIDGETS] &&
      !(t.name === 'get_active_alerts' && !(t.output as { alerts?: unknown[] })?.alerts?.length), // no alerts: no banner
  )
  // Charts span the column; small widgets share a two-column grid on wide screens.
  const large = widgets.filter((t) => !SMALL.has(t.name))
  const small = widgets.filter((t) => SMALL.has(t.name))
  const renderWidget = (t: ToolPartView, className?: string) => {
    const Widget = WIDGETS[t.name as keyof typeof WIDGETS]!
    return (
      <div key={t.toolCallId} className={className}>
        <ErrorBoundary fallback={() => <WidgetFallback tool={t.name} />}>
          <Suspense fallback={<Skeleton className="h-40 w-full rounded-3xl" />}>
            <Widget data={t.output} />
          </Suspense>
        </ErrorBoundary>
      </div>
    )
  }

  return (
    <Message>
      <MessageContent className="gap-3 text-base">
        <ToolSteps tools={tools} thinking={streaming && !response && allDone} streaming={streaming} />
        <div aria-live="polite">
          {response ? <AnswerCard response={response} /> : streaming ? <PendingAnswer /> : <NoAnswer />}
        </div>
        {large.map((t) => renderWidget(t))}
        {small.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {small.map((t) => renderWidget(t, small.length === 1 ? 'md:col-span-2' : undefined))}
          </div>
        )}
      </MessageContent>
    </Message>
  )
}

/** The turn ended without a data-answer part: stopped, cut off, or an unfinished turn restored from history. */
export function NoAnswer() {
  return (
    <p className="flex items-center gap-2 rounded-3xl bg-muted px-5 py-3.5 text-sm text-muted-foreground">
      <CircleSlashIcon className="size-4 shrink-0" />
      No answer received. The request was stopped or interrupted; ask again to get one.
    </p>
  )
}
