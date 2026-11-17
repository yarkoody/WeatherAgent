import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { InfoTip } from '@/components/InfoTip'
import { SecondOpinionCell } from '@/components/SecondOpinionCell'
import { Spinner } from '@/components/ui/spinner'
import { useDebug } from '@/lib/debug'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { fetchSecondOpinion, rerunSecondOpinion } from '@/lib/secondOpinion'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { BAND_COLOR, FAMILY_LABEL, fmt, pct, shortHubName } from '@/lib/format'
import { USE_MOCKS, apiFetch } from '@/lib/mockFetch'
import type { Band, ScoreRow, SecondOpinion } from '@/lib/types'
import { BandText } from '@/widgets/WidgetFrame'

const THRESHOLDS = { medium: 35, high: 60 }

type SortKey = 'typical' | 'bad_year' | 'priority'

const SORT: Record<SortKey, { label: string; field: 'exposure_days_per_year' | 'bad_year_days' | 'priority' }> = {
  typical: { label: 'Typical year', field: 'exposure_days_per_year' },
  bad_year: { label: 'Bad year', field: 'bad_year_days' },
  priority: { label: 'Priority', field: 'priority' },
}

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
  const [opinion, setOpinion] = useState<SecondOpinion | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    fetchSecondOpinion(ctl.signal).then((o) => {
      if (!ctl.signal.aborted) setOpinion(o)
    })
    return () => ctl.abort()
  }, [])
  // Narrow screens: the JEV column collapses into a compact badge next to the hub name.
  const narrow = useMediaQuery('(max-width: 639px)')
  const jevColumn = opinion !== null && !narrow
  const jevByHub = useMemo(() => new Map(opinion?.hubs.map((h) => [h.hub_id, h]) ?? []), [opinion])

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
    () => (rows ? [...rows].sort((a, b) => b[SORT[sort].field] - a[SORT[sort].field] || a.hub_id.localeCompare(b.hub_id)) : null),
    [rows, sort],
  )

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-wide text-2xl font-semibold tracking-tight">All hubs</h1>
            <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
              Lost days are the weather-disruption days a hub can expect: in a typical year, and in a bad year (about 1 in 20). The bar is the 0 to 100 exposure score. Investment priority says where upgrades would help most.
             
              {USE_MOCKS && ' Mock mode: showing recorded snapshot scores.'}
            </p>
          </div>
          <div className="inline-flex gap-1 rounded-2xl bg-card p-1 ring-1 ring-border/60" role="group" aria-label="Sort by">
            {(['typical', 'bad_year', 'priority'] as const).map((k) => (
              <Button key={k} size="sm" variant={sort === k ? 'default' : 'ghost'} aria-pressed={sort === k} onClick={() => setSort(k)}>
                {SORT[k].label}
              </Button>
            ))}
          </div>
        </div>

        {opinion && <SecondOpinionSummary opinion={opinion} onRerun={setOpinion} />}

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
            <Table className={jevColumn ? 'min-w-[900px]' : 'min-w-[780px]'}>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">#</TableHead>
                  <TableHead>Hub</TableHead>
                  <TableHead className="w-[22%]">Typical year (lost days)</TableHead>
                  <TableHead>
                    Bad year<span className="font-normal"> (1 in 20)</span>
                  </TableHead>
                  <TableHead>Hurricane chance, 10 yr</TableHead>
                  <TableHead className="w-[22%]">Investment priority</TableHead>
                  <TableHead>Top driver</TableHead>
                  {jevColumn && <TableHead>Second opinion (JEV)</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((r, i) => (
                  <TableRow key={r.hub_id}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableHead scope="row" className="font-semibold text-foreground">
                      <span className="inline-flex items-center gap-1.5">
                        <span>
                          {shortHubName(r.name)}
                          <span className="block text-xs font-normal text-muted-foreground">{r.region}</span>
                        </span>
                        {opinion && narrow && jevByHub.get(r.hub_id) && <SecondOpinionCell hub={jevByHub.get(r.hub_id)!} />}
                      </span>
                    </TableHead>
                    <TableCell>
                      <ScoreCell
                        text={`${fmt(r.exposure_days_per_year)} d`}
                        meter={r.exposure}
                        band={r.exposure_band}
                        info={<InfoTip subject={`${shortHubName(r.name)} typical year`} steps={rowLines(r, 'typical')} />}
                      />
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-0.5 font-semibold">
                        {fmt(r.bad_year_days)} d
                        <InfoTip subject={`${shortHubName(r.name)} bad year`} steps={rowLines(r, 'bad_year')} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-0.5">
                        {pct(r.hurricane_10yr_probability_pct)}
                        <InfoTip subject={`${shortHubName(r.name)} hurricane chance`} steps={rowLines(r, 'hurricane')} />
                      </span>
                    </TableCell>
                    <TableCell>
                      <ScoreCell
                        text={fmt(r.priority)}
                        meter={r.priority}
                        band={r.priority_band}
                        info={<InfoTip subject={`${shortHubName(r.name)} investment priority`} steps={rowLines(r, 'priority')} />}
                      />
                    </TableCell>
                    <TableCell className="text-muted-foreground">{FAMILY_LABEL[r.top_driver]}</TableCell>
                    {jevColumn && (
                      <TableCell>
                        {jevByHub.get(r.hub_id) ? <SecondOpinionCell hub={jevByHub.get(r.hub_id)!} /> : <span className="text-muted-foreground">Not rated</span>}
                      </TableCell>
                    )}
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
function rowLines(r: ScoreRow, kind: 'typical' | 'bad_year' | 'hurricane' | 'priority'): string[] {
  const hub = shortHubName(r.name)
  const ask = `Ask "Break down ${hub}'s risk" in chat for the details.`
  switch (kind) {
    case 'typical':
      return [
        `${hub} loses about ${fmt(r.exposure_days_per_year)} days a year to weather in a typical year.`,
        `That gives an exposure score of ${fmt(r.exposure)} of 100 (${r.exposure_band}).`,
        `Main driver: ${FAMILY_LABEL[r.top_driver].toLowerCase()}. ${ask}`,
      ]
    case 'bad_year':
      return [
        `In a bad year (about 1 year in 20) ${hub} could lose about ${fmt(r.bad_year_days)} days, because rare events like hurricanes are much worse than average.`,
        `In a typical year it loses about ${fmt(r.exposure_days_per_year)} days.`,
      ]
    case 'hurricane':
      return [
        `${hub} has a ${pct(r.hurricane_10yr_probability_pct)} chance of at least one hurricane in the next 10 years.`,
        'Hurricanes are rare but severe, so they are judged by this chance rather than by average days.',
      ]
    case 'priority':
      return [
        `Investment priority ${fmt(r.priority)} of 100 (${r.priority_band}): where upgrades would help most.`,
        'It mixes the exposure score with people served and the resilience gap.',
        ask,
      ]
  }
}

/** A value, its (i), and the 0-100 band ruler (the exposure index or the priority score). */
function ScoreCell({ text, meter, band, info }: { text: string; meter: number; band: Band; info?: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex w-16 shrink-0 items-center justify-end gap-0.5 font-semibold whitespace-nowrap">
        {text}
        {info}
      </span>
      <BandMeter value={meter} band={band} />
      <span className="w-14 shrink-0">
        <BandText band={band} />
      </span>
    </div>
  )
}

const JEV_EXPLAINER =
  "Independent rating by TypeSafe's JEV decision model on the same raw signals. It does not affect scores or rankings; disagreements are worth an analyst's review."

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

/** One line above the table, plus the developer-only re-run. */
function SecondOpinionSummary({ opinion, onRerun }: { opinion: SecondOpinion; onRerun: (o: SecondOpinion) => void }) {
  const debug = useDebug()
  const [running, setRunning] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)

  async function rerun() {
    setRunning(true)
    setDetail(null)
    const result = await rerunSecondOpinion()
    setRunning(false)
    if (result.ok) onRerun(result.opinion)
    else setDetail(result.detail)
  }

  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <p className="flex min-w-0 flex-1 basis-80 items-start gap-1 text-muted-foreground">
        <span>
          <span className="text-foreground">
            JEV agrees with the formula on {opinion.agree_count} of {opinion.total} ratings ({opinion.agreement_pct}%).
          </span>{' '}
          {typeof opinion.rank_correlation === 'number' && <>Rank agreement {opinion.rank_correlation} (1 means the same order). </>}
          Run {formatDate(opinion.run_at)} on data as of {opinion.data_as_of}.
          {debug && <span className="ml-1 text-xs">Model: {opinion.model}.</span>}
        </span>
        <InfoTip subject="JEV second opinion" title="About the JEV second opinion" steps={[JEV_EXPLAINER]} />
      </p>
      {debug && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={rerun} disabled={running} aria-busy={running}>
            {running && <Spinner />}
            {running ? 'Re-running JEV…' : 'Re-run JEV'}
          </Button>
        </div>
      )}
      {detail && (
        <p className="basis-full text-xs text-[#9b2f2a]" role="status">
          {detail}
        </p>
      )}
    </div>
  )
}
