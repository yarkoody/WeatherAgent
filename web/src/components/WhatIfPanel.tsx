// What if: analyst-supplied hazard weights and upgrade costs re-rank screening priority (POST /what-if).
// The scores themselves never change; this is a sensitivity view.
import { ArrowDownIcon, ArrowUpIcon, MinusIcon, RotateCcwIcon } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { HazardIcon } from '@/components/HazardIcon'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { FAMILIES, FAMILY_LABEL, fmt, shortHubName } from '@/lib/format'
import { USE_MOCKS, apiFetch } from '@/lib/mockFetch'
import type { Family, ScoreRow, WhatIfInput, WhatIfResult } from '@/lib/types'

/** Log-ish steps: fine control near 1x, coarse at the ends. */
export const WEIGHT_STEPS = [0.1, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 5]
const DEFAULT = WEIGHT_STEPS.indexOf(1)
const label = (w: number) => `×${w}`

function buildInput(weights: Record<Family, number>, costs: Record<string, string>): WhatIfInput | null {
  const family_weights = Object.fromEntries(FAMILIES.filter((f) => weights[f] !== DEFAULT).map((f) => [f, WEIGHT_STEPS[weights[f]]]))
  const upgrade_costs = Object.entries(costs)
    .map(([hub_id, v]) => ({ hub_id, cost_musd: Number(v) }))
    .filter((c) => Number.isFinite(c.cost_musd) && c.cost_musd >= 0.1 && c.cost_musd <= 1000)
  if (Object.keys(family_weights).length === 0 && upgrade_costs.length === 0) return null
  return {
    ...(Object.keys(family_weights).length ? { family_weights } : {}),
    ...(upgrade_costs.length ? { upgrade_costs } : {}),
  }
}

export function WhatIfPanel({ rows }: { rows: ScoreRow[] }) {
  const [weights, setWeights] = useState<Record<Family, number>>({ winter: DEFAULT, flood: DEFAULT, hurricane: DEFAULT, severe_storm: DEFAULT })
  const [costs, setCosts] = useState<Record<string, string>>({})
  const [result, setResult] = useState<WhatIfResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useMemo(() => buildInput(weights, costs), [weights, costs])
  const key = JSON.stringify(input)

  // Debounced request: one call ~250 ms after the last change; defaults mean "no what-if".
  useEffect(() => {
    if (!input) {
      setResult(null)
      setError(null)
      return
    }
    const ctl = new AbortController()
    const t = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await apiFetch('/what-if', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: ctl.signal })
        if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { detail?: string } | null)?.detail ?? `HTTP ${res.status}`)
        setResult((await res.json()) as WhatIfResult)
        setError(null)
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message)
      } finally {
        if (!ctl.signal.aborted) setLoading(false)
      }
    }, 250)
    return () => {
      clearTimeout(t)
      ctl.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const baselineRank = useMemo(() => {
    const order = [...rows].sort((a, b) => b.priority - a.priority || a.hub_id.localeCompare(b.hub_id))
    return new Map(order.map((r, i) => [r.hub_id, i + 1]))
  }, [rows])

  const reset = () => {
    setWeights({ winter: DEFAULT, flood: DEFAULT, hurricane: DEFAULT, severe_storm: DEFAULT })
    setCosts({})
  }

  return (
    <section aria-label="What if" className="glass mt-4 rounded-3xl p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="heading-tight text-base font-semibold">What if</h2>
          <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">Analyst-supplied weights and costs. Scores themselves do not change.</p>
        </div>
        <Button variant="outline" size="sm" onClick={reset} disabled={!input}>
          <RotateCcwIcon />
          Reset
        </Button>
      </div>

      <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <p className="text-xs text-muted-foreground">How much one lost day from each hazard counts (default ×1, all equal).</p>
          {FAMILIES.map((f) => (
            <label key={f} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-3 text-sm">
              <span className="inline-flex items-center gap-1.5">
                <HazardIcon hazard={f} />
                {FAMILY_LABEL[f]}
              </span>
              <input
                type="range"
                min={0}
                max={WEIGHT_STEPS.length - 1}
                step={1}
                value={weights[f]}
                aria-label={`${FAMILY_LABEL[f]} weight`}
                aria-valuetext={label(WEIGHT_STEPS[weights[f]])}
                onChange={(e) => setWeights((w) => ({ ...w, [f]: Number(e.target.value) }))}
                className="w-full accent-[var(--color-isobar)]"
              />
              <span className={`text-right tabular-nums ${weights[f] === DEFAULT ? 'text-muted-foreground' : 'font-semibold'}`}>{label(WEIGHT_STEPS[weights[f]])}</span>
            </label>
          ))}

          <details className="rounded-2xl bg-foreground/[0.03] px-3 py-2">
            <summary className="text-sm font-medium">Upgrade costs ($M, optional)</summary>
            <p className="mt-1 text-xs text-muted-foreground">Enter a cost to rank hubs by priority per $1M.</p>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
              {[...rows]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((r) => (
                  <label key={r.hub_id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{shortHubName(r.name)}</span>
                    <input
                      inputMode="decimal"
                      value={costs[r.hub_id] ?? ''}
                      onChange={(e) => setCosts((c) => ({ ...c, [r.hub_id]: e.target.value }))}
                      aria-label={`Upgrade cost for ${shortHubName(r.name)} ($M)`}
                      placeholder="–"
                      className="h-8 w-16 rounded-lg border border-border/70 bg-background/70 px-2 text-right text-sm tabular-nums"
                    />
                  </label>
                ))}
            </div>
          </details>
        </div>

        <div aria-live="polite">
          {!input && <p className="text-sm text-muted-foreground">Move a slider or enter a cost to see the re-ranked priority.</p>}
          {input && loading && !result && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner /> Recalculating…
            </p>
          )}
          {error && <p className="text-sm text-band-high-text">The what-if could not be calculated ({error}).</p>}
          {input && result && (
            <div className={loading ? 'opacity-60 transition-opacity' : ''}>
              <h3 className="text-sm font-medium">Screening priority with these inputs</h3>
              <ol aria-label="What-if priority ranking" className="mt-2 space-y-1">
                {result.ranking.map((r) => (
                  <li key={r.hub_id} className="grid grid-cols-[1.5rem_1fr_3rem_3.5rem] items-center gap-2 text-sm">
                    <span className="text-muted-foreground tabular-nums">{r.rank}</span>
                    <span className="truncate">{shortHubName(r.name)}</span>
                    <span className="text-right font-semibold tabular-nums">{fmt(r.value)}</span>
                    <RankChange from={baselineRank.get(r.hub_id)} to={r.rank} />
                  </li>
                ))}
              </ol>
              {result.per_million_ranking && result.per_million_ranking.length > 0 && (
                <>
                  <h3 className="mt-4 text-sm font-medium">Priority per $1M</h3>
                  <ol aria-label="Priority per $1M" className="mt-2 space-y-1">
                    {result.per_million_ranking.map((r) => (
                      <li key={r.hub_id} className="grid grid-cols-[1.5rem_1fr_auto] items-center gap-2 text-sm">
                        <span className="text-muted-foreground tabular-nums">{r.rank}</span>
                        <span className="truncate">
                          {shortHubName(r.name)} <span className="text-xs text-muted-foreground">(${fmt(r.cost_musd, 2)}M)</span>
                        </span>
                        <span className="text-right font-semibold tabular-nums">{fmt(r.priority_per_million, 2)}</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <p className="mt-3 text-xs text-muted-foreground">{result.note}</p>
              {USE_MOCKS && <p className="mt-1 text-xs text-band-medium-text">Mock mode: a recorded example result, not computed from these exact inputs.</p>}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function RankChange({ from, to }: { from?: number; to: number }) {
  if (!from || from === to)
    return (
      <span className="inline-flex items-center justify-end text-muted-foreground" aria-label="No change">
        <MinusIcon className="size-3.5" />
      </span>
    )
  const up = from > to
  const n = Math.abs(from - to)
  return (
    <span
      className={`inline-flex items-center justify-end gap-0.5 text-xs font-semibold tabular-nums ${up ? 'text-isobar' : 'text-muted-foreground'}`}
      aria-label={`${up ? 'Up' : 'Down'} ${n}`}
    >
      {up ? <ArrowUpIcon className="size-3.5" /> : <ArrowDownIcon className="size-3.5" />}
      {n}
    </span>
  )
}
