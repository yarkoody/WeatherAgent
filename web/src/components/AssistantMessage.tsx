import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { CircleSlashIcon } from 'lucide-react'
import { ChevronRightIcon, MapPinIcon } from 'lucide-react'
import { Suspense, useState, type ReactNode } from 'react'
import { useDebug } from '@/lib/debug'
import { useReducedMotion } from '@/lib/motion'
import { Skeleton } from '@/components/ui/skeleton'
import { Suggestions } from '@/components/ai-elements/suggestions'
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

/** Notes the tools add when a city was resolved to a hub (nickname or metro area), each once, in order. */
export function resolutionNotes(message: UIMessage): string[] {
  const notes: string[] = []
  for (const t of toolParts(message)) {
    const out = t.output as { resolution_notes?: unknown } | undefined
    if (t.state !== 'output-available' || !Array.isArray(out?.resolution_notes)) continue
    for (const n of out.resolution_notes) if (typeof n === 'string' && !notes.includes(n)) notes.push(n)
  }
  return notes
}

/** The single data-answer part: the grounding-verified ChatResponse. */
export function answerPart(message: UIMessage): ChatResponse | null {
  const part = message.parts.find((p) => p.type === 'data-answer') as { data: ChatResponse } | undefined
  return part?.data ?? null
}

/** The agent's turn: tool steps, the verified answer card, then one widget per tool output. */
export function AssistantMessage({
  message,
  streaming,
  latest = false,
  onFollowUp,
}: {
  message: UIMessage
  streaming: boolean
  /** Only the latest finished answer offers follow-up questions. */
  latest?: boolean
  onFollowUp?: (question: string) => void
}) {
  const debug = useDebug()
  const reduced = useReducedMotion()
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
      <div
        key={t.toolCallId}
        className={`${reduced ? '' : 'animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none'} ${className ?? ''}`}
      >
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
        {/* Analyst view: once the answer is in, the steps fold into one line so the answer comes first. */}
        {response && !debug && tools.length > 0 ? (
          <FoldedSteps count={tools.length}>
            <ToolSteps tools={tools} thinking={false} streaming={false} />
          </FoldedSteps>
        ) : (
          <ToolSteps tools={tools} thinking={streaming && !response && allDone} streaming={streaming} />
        )}
        <ResolutionNotes notes={resolutionNotes(message)} />
        <div aria-live="polite">
          {response ? <AnswerCard response={response} /> : streaming ? <PendingAnswer /> : <NoAnswer />}
        </div>
        {large.map((t) => renderWidget(t))}
        {small.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {small.map((t) => renderWidget(t, small.length === 1 ? 'md:col-span-2' : undefined))}
          </div>
        )}
        {latest && !streaming && onFollowUp && (response?.follow_ups?.length ?? 0) > 0 && (
          <div className={`pt-1 ${reduced ? '' : 'animate-in fade-in slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none'}`}>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Ask next</p>
            <Suggestions suggestions={response!.follow_ups!} onPick={onFollowUp} align="start" label="Ask next" />
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
      No answer received. The request was stopped or interrupted. Ask again to continue.
    </p>
  )
}

function FoldedSteps({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={`size-4 transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`} />
        Analysis steps ({count})
      </button>
      {open && <div className="mt-2 pl-1">{children}</div>}
    </div>
  )
}

/** Tool text, shown as is: says which hub stands in for the city the analyst named. */
function ResolutionNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null
  return (
    <div role="note" aria-label="How the hub was chosen" className="flex items-start gap-2 px-1 text-sm text-muted-foreground">
      <MapPinIcon className="mt-0.5 size-4 shrink-0 text-isobar" aria-hidden="true" />
      <div className="space-y-0.5">
        {notes.map((n) => (
          <p key={n}>{n}</p>
        ))}
      </div>
    </div>
  )
}
