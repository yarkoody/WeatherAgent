// Developer mode: "Validation details" under each finished answer. Figures with their source tool and field,
// the grounding result, the tools called (arguments and result size), and the turn's timing, tokens and cost.
import { CheckIcon, CopyIcon, XIcon } from 'lucide-react'
import { useState } from 'react'
import type { ToolPartView } from '@/components/ai-elements/tool-steps'
import { fieldPath } from '@/components/ai-elements/inline-citation'
import { Button } from '@/components/ui/button'
import { formatValue, hubName, isNum } from '@/lib/format'
import type { ChatResponse, Figure } from '@/lib/types'

const STATUS: Record<string, string> = {
  pass: 'passed first try',
  retried: 'passed after one retry',
  failed: 'failed',
}

/** Grounding errors that name a figure ("Figure 'exposure' cites …") attach to that figure's row. */
export function errorsFor(figure: Figure, errors: string[]): string[] {
  return errors.filter((e) => e.startsWith(`Figure '${figure.label}'`))
}

/** "1.2 kB" for a tool result's JSON size. */
export function resultSize(output: unknown): string {
  if (output === undefined) return 'no result'
  const bytes = new TextEncoder().encode(JSON.stringify(output)).length
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`
}

const compactJson = (v: unknown) => {
  const s = JSON.stringify(v ?? {})
  return s.length > 160 ? `${s.slice(0, 157)}…` : s
}

export function ValidationPanel({ response, tools }: { response: ChatResponse; tools: ToolPartView[] }) {
  const { grounding, answer, usage } = response
  const errors = grounding.errors ?? []
  const passed = grounding.status !== 'failed'
  const attached = new Set(answer.figures.flatMap((f) => errorsFor(f, errors)))
  const loose = errors.filter((e) => !attached.has(e))
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(response.trace_id).then(() => setCopied(true))
  }
  const candidates: [string, string | null][] = usage
    ? [
        ['Latency', isNum(usage.latency_ms) ? `${(usage.latency_ms / 1000).toFixed(2)} s` : null],
        ['Input tokens', isNum(usage.input_tokens) ? usage.input_tokens.toLocaleString('en-US') : null],
        ['Output tokens', isNum(usage.output_tokens) ? usage.output_tokens.toLocaleString('en-US') : null],
        ['Estimated cost', isNum(usage.cost_usd) ? `$${usage.cost_usd.toFixed(4)}` : null],
        ['Tool calls', isNum(usage.tool_calls) ? String(usage.tool_calls) : null],
      ]
    : []
  const usageRows = candidates.filter((r): r is [string, string] => r[1] !== null) // null rows are hidden

  return (
    <section aria-label="Validation details" className="glass rounded-3xl p-5 text-sm">
      <h3 className="heading-tight font-semibold">Validation details</h3>

      <h4 className="mt-3 text-xs font-semibold text-muted-foreground">Figures</h4>
      {answer.figures.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">This answer cites no figures.</p>
      ) : (
        <ul aria-label="Figures and their sources" className="mt-1 space-y-1 font-mono text-[0.7rem] leading-relaxed">
          {answer.figures.map((f, i) => {
            const errs = errorsFor(f, errors)
            const ok = passed && errs.length === 0
            return (
              <li key={`${f.label}-${i}`} data-figure-row className="break-words">
                <span className="text-muted-foreground">{f.hub_id ? hubName(f.hub_id) : 'General'} · </span>
                {f.label} · <span className="font-semibold text-foreground">{formatValue(f.value, f.unit)}</span>
                <span className="text-muted-foreground">
                  {' ← '}
                  {f.source_tool}
                  {fieldPath(f) ? ` → ${fieldPath(f)}` : ''}
                </span>{' '}
                {ok ? (
                  <CheckIcon className="inline size-3.5 text-band-low-text" aria-label="validated" />
                ) : (
                  <XIcon className="inline size-3.5 text-band-high-text" aria-label="not validated" />
                )}
                {errs.map((e) => (
                  <span key={e} className="block pl-3 text-band-high-text">
                    {e}
                  </span>
                ))}
              </li>
            )
          })}
        </ul>
      )}

      <h4 className="mt-3 text-xs font-semibold text-muted-foreground">Validation</h4>
      <p className="mt-1 text-xs" data-testid="validation-status">
        Grounding {STATUS[grounding.status] ?? grounding.status}.
      </p>
      {loose.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-5 font-mono text-[0.7rem] text-band-high-text">
          {loose.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <h4 className="mt-3 text-xs font-semibold text-muted-foreground">Tools</h4>
      {tools.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">No tools were called.</p>
      ) : (
        <ol aria-label="Tool calls" className="mt-1 list-decimal space-y-1 pl-5 font-mono text-[0.7rem] leading-relaxed">
          {tools.map((t) => (
            <li key={t.toolCallId} data-tool-row className="break-words">
              <span className="font-semibold text-foreground">{t.name}</span> <span className="text-muted-foreground">{compactJson(t.input)}</span>
              <span className="text-muted-foreground"> → {t.state === 'output-error' ? 'error' : resultSize(t.output)}</span>
            </li>
          ))}
        </ol>
      )}

      <h4 className="mt-3 text-xs font-semibold text-muted-foreground">Turn</h4>
      <dl aria-label="Turn" className="mt-1 grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 font-mono text-[0.7rem]">
        <dt className="text-muted-foreground">Trace id</dt>
        <dd className="flex items-center gap-1">
          <span className="break-all">{response.trace_id}</span>
          <Button variant="ghost" size="icon-xs" aria-label={copied ? 'Trace id copied' : 'Copy trace id'} onClick={copy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
          </Button>
        </dd>
        {usageRows.map(([k, v]) => (
          <div key={k} className="contents" data-usage-row={k}>
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
