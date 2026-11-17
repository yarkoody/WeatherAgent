import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { InfoTip } from '@/components/InfoTip'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { BAND_COLOR, FAMILY_LABEL, fmt, shortHubName } from '@/lib/format'
import { USE_MOCKS, apiFetch } from '@/lib/mockFetch'
import type { Band, ScoreRow } from '@/lib/types'
import { BandPill } from '@/widgets/WidgetFrame'

const THRESHOLDS = { medium: 35, high: 60 }

type SortKey = 'priority' | 'exposure'

/** 0-100 ruler with the band cut-offs marked: the same scale every widget uses. */
export function BandMeter({ value, band }: { value: number; band: Band }) {
  return (
    <div className="relative h-2 w-full min-w-16 rounded-full bg-muted" aria-hidden="true">
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(value, 100)}%`, background: BAND_COLOR[band] }} />
      <span className="absolute -inset-y-0.5 w-px bg-foreground/25" style={{ left: `${THRESHOLDS.medium}%` }} />
      <span className="absolute -inset-y-0.5 w-px bg-foreground/25" style={{ left: `${THRESHOLDS.high}%` }} />
    </div>
  )
}

export function ScoresView() {
  const [rows, setRows] = useState<ScoreRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sort, setSort] = useState<SortKey>('priority')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const ctl = new AbortController()
    setError(null)
    apiFetch('/scores', { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { detail?: string } | null)?.detail ?? `HTTP ${r.status}`)
        return r.json() as Promise<ScoreRow[]>
      })
      .then(setRows)
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message)
      })
    return () => ctl.abort()
  }, [attempt])

  const sorted = useMemo(
    () => (rows ? [...rows].sort((a, b) => b[sort] - a[sort] || a.hub_id.localeCompare(b.hub_id)) : null),
    [rows, sort],
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-wide text-2xl font-semibold tracking-tight">All hubs</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Exposure is a 0 to 100 index of expected weather-disruption days a year. Priority adds people served and the resilience gap.
              Bands: medium from 35, high from 60.
              {USE_MOCKS && ' Mock mode: showing recorded snapshot scores.'}
            </p>
          </div>
          <div className="inline-flex gap-1 rounded-2xl bg-card p-1 ring-1 ring-border/60" role="group" aria-label="Sort by">
            {(['priority', 'exposure'] as const).map((k) => (
              <Button key={k} size="sm" variant={sort === k ? 'default' : 'ghost'} aria-pressed={sort === k} onClick={() => setSort(k)}>
                {k === 'priority' ? 'Sort by priority' : 'Sort by exposure'}
              </Button>
            ))}
          </div>
        </div>

        {/* Tier 2 slot: US hub map and what-if weight sliders go here, above the table. */}

        {error && (
          <div className="mt-6 flex flex-wrap items-center gap-3 rounded-lg bg-band-high-soft px-4 py-3 text-sm text-[#7d2622]" role="alert">
            Scores could not be loaded ({error}).
            <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        )}
        {!sorted && !error && (
          <div className="mt-5 space-y-2" aria-label="Loading scores">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        )}

        {sorted && (
          <div className="mt-5 rounded-2xl bg-card px-2 ring-1 ring-border/60">
            <Table className="min-w-[720px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Hub</TableHead>
                  <TableHead>Region</TableHead>
                  <TableHead className="w-[24%]">Exposure</TableHead>
                  <TableHead className="w-[24%]">Investment priority</TableHead>
                  <TableHead>Top driver</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r, i) => (
                  <TableRow key={r.hub_id}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableHead scope="row" className="font-semibold text-foreground">
                      {shortHubName(r.name)}
                    </TableHead>
                    <TableCell className="text-muted-foreground">{r.region}</TableCell>
                    <TableCell>
                      <ScoreCell value={r.exposure} band={r.exposure_band} info={<InfoTip subject={`${shortHubName(r.name)} exposure index`} lines={rowLines(r, 'exposure')} />} />
                    </TableCell>
                    <TableCell>
                      <ScoreCell value={r.priority} band={r.priority_band} info={<InfoTip subject={`${shortHubName(r.name)} investment priority`} lines={rowLines(r, 'priority')} />} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{FAMILY_LABEL[r.top_driver]}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  )
}

/** A /scores row has no signals, so the text explains in words and points to the per-hub breakdown. */
function rowLines(r: ScoreRow, kind: 'exposure' | 'priority'): string[] {
  const hub = shortHubName(r.name)
  return kind === 'exposure'
    ? [
        `${hub}: exposure index ${r.exposure} (${r.exposure_band}).`,
        'The index turns expected weather-disruption days a year into a 0 to 100 scale; more days means a higher index.',
        `Top driver: ${FAMILY_LABEL[r.top_driver].toLowerCase()}. Ask "Break down ${hub}'s risk" in chat for each hazard's days and the formula.`,
      ]
    : [
        `${hub}: investment priority ${r.priority} (${r.priority_band}).`,
        'Priority blends overall exposure with people served and the resilience gap.',
        `Ask "Break down ${hub}'s risk" in chat for each signal, its weight and its contribution.`,
      ]
}

function ScoreCell({ value, band, info }: { value: number; band: Band; info?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex w-14 items-center justify-end gap-0.5 font-semibold">
        {fmt(value)}
        {info}
      </span>
      <BandMeter value={value} band={band} />
      <BandPill band={band} />
    </div>
  )
}
