import { getToolName, isToolUIPart, type UIMessage } from 'ai'
import { CircleSlashIcon } from 'lucide-react'
import { ChevronRightIcon, MapPinIcon, SquareIcon, Volume2Icon } from 'lucide-react'
import { Suspense, useState, type ReactNode } from 'react'
import { useDebug } from '@/lib/debug'
import { useReducedMotion } from '@/lib/motion'
import { answerSpeech, speakMessage, speechSupported, stopSpeaking, useSpeakingId } from '@/lib/voice'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Skeleton } from '@/components/ui/skeleton'
import { Suggestions } from '@/components/ai-elements/suggestions'
import { ToolSteps, type ToolPartView } from '@/components/ai-elements/tool-steps'
import { ErrorBoundary, WidgetFallback } from '@/components/ErrorBoundary'
import { Message, MessageContent } from '@/components/ui/message'
import type { ChatResponse } from '@/lib/types'
import { isToolError } from '@/lib/types'
import { WIDGETS } from '@/widgets'
import { AnswerCard, CARD_SHELL, PendingAnswer } from './AnswerCard'

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

/**
 * Draw a tool's widget only when the answer uses that output: no charts under a refusal or a "no data" answer,
 * a hub widget only for a hub the answer is about, a ranking only for a ranked (or in-scope, with data) answer.
 */
export function answerUses(response: ChatResponse, t: ToolPartView): boolean {
  const a = response.answer
  if (!a.in_scope || !a.data_available) return false
  const hubs = new Set(a.hubs ?? [])
  const out = t.output as { hub_id?: string; hubs?: { hub_id: string }[] } | undefined
  switch (t.name) {
    case 'rank_hubs':
      return true // in scope with data (a ranked answer or not)
    case 'compare_hubs':
      return (out?.hubs ?? []).some((h) => hubs.has(h.hub_id))
    default:
      return out?.hub_id ? hubs.has(out.hub_id) : true
  }
}

/** A chart that is still loading: the same card shell as the finished widget, with placeholder lines. */
function WidgetLoading() {
  return (
    <div className={`${CARD_SHELL} h-40`} role="status" aria-label="Chart loading">
      <div className="space-y-3 py-1" aria-hidden="true">
        <Skeleton className="h-3 w-1/3" />
        <Skeleton className="h-2.5 w-10/12" />
        <Skeleton className="h-2.5 w-7/12" />
      </div>
    </div>
  )
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
  question,
  onRetry,
  errored = false,
  asked,
}: {
  /** Questions already asked in this chat (lowercased, trimmed): never offered again as "Ask next". */
  asked?: Set<string>
  message: UIMessage
  /** Retry this turn (only the latest message gets it). */
  onRetry?: () => void
  /** The request for this turn failed; the chat shows the network banner when nothing arrived. */
  errored?: boolean
  /** The user's question for this answer (for the printed report). */
  question?: string
  streaming: boolean
  /** Only the latest finished answer offers follow-up questions. */
  latest?: boolean
  onFollowUp?: (question: string) => void
}) {
  const debug = useDebug()
  const reduced = useReducedMotion()
  const tools = toolParts(message)
  const response = answerPart(message)
  const followUps = (response?.follow_ups ?? []).filter((q) => !asked?.has(normalizeQuestion(q)))
  const allDone = tools.every((t) => t.state === 'output-available' || t.state === 'output-error')
  const widgets = tools.filter(
    (t) =>
      t.state === 'output-available' &&
      !isToolError(t.output) &&
      WIDGETS[t.name as keyof typeof WIDGETS] &&
      !(t.name === 'get_active_alerts' && !(t.output as { alerts?: unknown[] })?.alerts?.length) && // no alerts: no banner
      (!response || answerUses(response, t)),
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
          <Suspense fallback={<WidgetLoading />}>
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
          {response ? (
            <AnswerCard response={response} dataAsOf={dataAsOfOf(tools)} question={question} />
          ) : streaming ? (
            <PendingAnswer />
          ) : tools.some((t) => t.state === 'output-available') ? (
            <CutOff onRetry={onRetry} />
          ) : errored ? null : (
            <NoAnswer />
          )}
        </div>
        {response && !streaming && speechSupported() && (
          <div className="-mt-1 flex items-center gap-1 px-1">
            <ReadAloud id={message.id} response={response} />
          </div>
        )}
        {large.map((t) => renderWidget(t))}
        {small.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {small.map((t) => renderWidget(t, small.length === 1 ? 'md:col-span-2' : undefined))}
          </div>
        )}
        {latest && !streaming && onFollowUp && followUps.length > 0 && (
          <div className={`pt-1 ${reduced ? '' : 'animate-in fade-in slide-in-from-bottom-1 duration-300 ease-out motion-reduce:animate-none'}`}>
            <p className="mb-2 text-xs font-medium text-muted-foreground">Ask next</p>
            <Suggestions suggestions={followUps} onPick={onFollowUp} align="start" label="Ask next" />
          </div>
        )}
      </MessageContent>
    </Message>
  )
}

/** For "already asked" checks: case, spacing and a trailing question mark or period do not matter. */
export const normalizeQuestion = (q: string) => q.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?.!]+$/, '')

/** Tool results arrived but the answer did not: one message, with Try again on the latest turn. */
export function CutOff({ onRetry }: { onRetry?: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-3 rounded-3xl bg-muted px-5 py-3.5 text-sm text-muted-foreground">
      <CircleSlashIcon className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">The answer was cut off. The results above are complete; try again for the explanation.</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/** The turn ended without any result: stopped before anything arrived, or an unfinished turn restored from history. */
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

/** Reads this answer's verified text aloud; "Unverified answer." first when validation failed. */
function ReadAloud({ id, response }: { id: string; response: ChatResponse }) {
  const speaking = useSpeakingId() === id
  const label = speaking ? 'Stop reading' : 'Read aloud'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            aria-pressed={speaking}
            onClick={() => (speaking ? stopSpeaking() : speakMessage(id, answerSpeech(response)))}
            className="text-muted-foreground hover:text-foreground"
          />
        }
      >
        {speaking ? <SquareIcon className="fill-current" /> : <Volume2Icon />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** The snapshot date the tools reported (for the printed report). */
function dataAsOfOf(tools: ToolPartView[]): string | undefined {
  for (const t of tools) {
    const d = (t.output as { data_as_of?: unknown } | undefined)?.data_as_of
    if (typeof d === 'string') return d
  }
  return undefined
}
