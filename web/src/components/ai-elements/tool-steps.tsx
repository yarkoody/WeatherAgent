// AI Elements "Tool" pattern (shadcn/ui, built on Trace): one row per tool part, mapped from its state.
import {
  BarChart3Icon,
  CircleSlashIcon,
  CloudSnowIcon,
  Columns2Icon,
  ListIcon,
  MapPinIcon,
  SirenIcon,
  SlidersHorizontalIcon,
  TriangleAlertIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react'
import { Spinner } from '@/components/ui/spinner'
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '@/components/ui/trace'
import { useDebug } from '@/lib/debug'
import { toolLabel } from '@/lib/toolLabels'
import { isToolError } from '@/lib/types'

export interface ToolPartView {
  toolCallId: string
  name: string
  state: 'input-streaming' | 'input-available' | 'output-available' | 'output-error'
  input: Record<string, unknown> | undefined
  output: unknown
  errorText?: string
}

const ICONS: Record<string, LucideIcon> = {
  list_hubs: ListIcon,
  rank_hubs: BarChart3Icon,
  get_hub_risk: MapPinIcon,
  compare_hubs: Columns2Icon,
  weather_stat: CloudSnowIcon,
  get_active_alerts: SirenIcon,
  what_if: SlidersHorizontalIcon,
}

function Arguments({ input }: { input: Record<string, unknown> | undefined }) {
  const entries = Object.entries(input ?? {}).filter(([, v]) => v !== null && v !== undefined)
  if (entries.length === 0) return <p className="text-xs text-muted-foreground">No arguments.</p>
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
      {entries.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-medium break-words">{Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * `streaming` is false once the turn is over (finished, stopped, or restored from history):
 * a tool still without output is then shown as stopped, never as a spinner.
 */
export function ToolSteps({ tools, thinking, streaming }: { tools: ToolPartView[]; thinking: boolean; streaming: boolean }) {
  const debug = useDebug()
  if (tools.length === 0 && !thinking) return null
  return (
    <Trace aria-label="Agent steps" aria-live="polite">
      {tools.map((t) => {
        const Icon = ICONS[t.name] ?? WrenchIcon
        const done = t.state === 'output-available' || t.state === 'output-error'
        const failed = t.state === 'output-error' || (t.state === 'output-available' && isToolError(t.output))

        if (!done && !streaming) {
          return (
            <TraceLine key={t.toolCallId} status="pending">
              <TraceIcon>
                <CircleSlashIcon />
              </TraceIcon>
              <TraceTitle>{toolLabel(t.name, t.input, false)} (stopped)</TraceTitle>
            </TraceLine>
          )
        }

        if (!done) {
          return (
            <TraceLine key={t.toolCallId} status="running">
              <TraceIcon>
                <Spinner />
              </TraceIcon>
              <TraceTitle>{toolLabel(t.name, t.input, false)}</TraceTitle>
            </TraceLine>
          )
        }

        const error = isToolError(t.output) ? t.output : null
        const line = (
          <TraceLine status={failed ? 'error' : undefined}>
            <TraceIcon>{failed ? <TriangleAlertIcon /> : <Icon />}</TraceIcon>
            <TraceTitle>
              {toolLabel(t.name, t.input, true)}
              {failed && ': no result'}
            </TraceTitle>
          </TraceLine>
        )
        // Analyst view: the plain-language step only. Developer view: expandable tool name and arguments.
        if (!debug) return <div key={t.toolCallId}>{line}</div>
        return (
          <TraceCollapsible key={t.toolCallId}>
            <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
            <TraceCollapsibleContent>
              <div className="space-y-1.5 rounded-lg bg-card px-3 py-2 ring-1 ring-border/60">
                <p className="text-xs text-muted-foreground">
                  Tool <code className="font-medium text-foreground">{t.name}</code>
                </p>
                <Arguments input={t.input} />
                {(error || t.errorText) && (
                  <p className="text-xs text-destructive">{error ? `${error.error} ${error.hint}` : t.errorText}</p>
                )}
              </div>
            </TraceCollapsibleContent>
          </TraceCollapsible>
        )
      })}
      {thinking && (
        <TraceLine status="running">
          <TraceIcon>
            <Spinner />
          </TraceIcon>
          <TraceTitle>{tools.length === 0 ? 'Reading the question' : 'Checking the numbers'}</TraceTitle>
        </TraceLine>
      )}
    </Trace>
  )
}
