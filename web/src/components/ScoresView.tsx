import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, DownloadIcon, SearchIcon, SlidersHorizontalIcon } from 'lucide-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { HazardIcon } from '@/components/HazardIcon'
import { InfoTip } from '@/components/InfoTip'
import { SecondOpinionCell } from '@/components/SecondOpinionCell'
import { SelectPill } from '@/components/SelectPill'
import { WhatIfPanel } from '@/components/WhatIfPanel'
import { downloadCsv } from '@/lib/exportCsv'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Spinner } from '@/components/ui/spinner'
import { useDebug } from '@/lib/debug'
import { BAND_COLOR, FAMILIES, FAMILY_LABEL, fmt, formatDate, pct, shortHubName } from '@/lib/format'
import { USE_MOCKS, apiFetch } from '@/lib/mockFetch'
import { fetchSecondOpinion, rerunSecondOpinion } from '@/lib/secondOpinion'
import type { Band, JevHubOpinion, Region, ScoreRow, SecondOpinion } from '@/lib/types'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { BandText } from '@/widgets/WidgetFrame'

const THRESHOLDS = { medium: 35, high: 60 }
const REGIONS: Region[] = ['Midwest', 'Northeast', 'South', 'West']
const BANDS: Band[] = ['high', 'medium', 'low']

/** 0-100 ruler with the band cut-offs marked: the same scale every widget uses. */
export function BandMeter({ value, band }: { value: number; band: Band }) {
  return (
    <div className="relative h-1.5 w-full min-w-14 rounded-full bg-foreground/10" aria-hidden="true">
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${Math.min(value, 100)}%`, background: BAND_COLOR[band] }} />
      <span className="absolute -inset-y-0.5 w-px bg-foreground/30" style={{ left: `${THRESHOLDS.medium}%` }} />
      <span className="absolute -inset-y-0.5 w-px bg-foreground/30" style={{ left: `${THRESHOLDS.high}%` }} />
    </div>
  )
}

// ---------- columns ----------

type SortKey = 'hub' | 'typical' | 'bad_year' | 'hurricane' | 'priority' | 'driver' | 'jev'
type Dir = 'asc' | 'desc'

interface Column {
  key: SortKey
  label: string
  align: 'left' | 'right'
  /** Direction on first click: numbers start high-to-low, names start A to Z. */
  first: Dir
  tip: { title: string; steps: string[] }
  value: (r: ScoreRow, jev?: JevHubOpinion) => number | string
}

const JEV_WHY =
  'JEV sees only raw signals (event counts, observed days), not our downtime-per-event assumptions or band cut-offs. It orders hubs much like the formula but draws band lines differently, and it underrates rare, severe events such as hurricanes. Disagreements are worth a look; they never change scores.'
const JEV_ABOUT =
  "An independent rating by TypeSafe's JEV decision model on the same raw signals. It does not affect scores or rankings."

const COLUMNS: Column[] = [
  { key: 'hub', label: 'Hub', align: 'left', first: 'asc', value: (r) => shortHubName(r.name), tip: { title: 'About hubs', steps: ['The 15 US logistics hubs, with their Census region.'] } },
  {
    key: 'typical',
    label: 'Typical year',
    align: 'right',
    first: 'desc',
    value: (r) => r.exposure_days_per_year,
    tip: {
      title: 'About the typical year',
      steps: ['Lost days a hub can expect in an average year, across all hazards.', 'The bar is the 0 to 100 exposure score; the two marks are the medium and high cut-offs.'],
    },
  },
  {
    key: 'bad_year',
    label: 'Bad year',
    align: 'right',
    first: 'desc',
    value: (r) => r.bad_year_days,
    tip: { title: 'About the bad year', steps: ['Average lost days in the worst 1 year in 20.', 'Averages hide rare, severe events such as hurricanes; this column shows them.'] },
  },
  {
    key: 'hurricane',
    label: 'Hurricane 10 yr',
    align: 'right',
    first: 'desc',
    value: (r) => r.hurricane_10yr_probability_pct,
    tip: {
      title: 'About the hurricane chance',
      steps: ['Chance of at least one hurricane-class event in the next 10 years.', 'Hurricanes are rare but severe, so they are judged by this chance rather than by average days.'],
    },
  },
  {
    key: 'priority',
    label: 'Priority',
    align: 'right',
    first: 'desc',
    value: (r) => r.priority,
    tip: { title: 'About investment priority', steps: ['Where upgrades would help most, from 0 to 100.', 'It mixes the exposure score with people served and the resilience gap.'] },
  },
  {
    key: 'driver',
    label: 'Top driver',
    align: 'left',
    first: 'asc',
    value: (r) => FAMILY_LABEL[r.top_driver],
    tip: { title: 'About the top driver', steps: ['The hazard that causes the most lost days in a typical year.'] },
  },
]

const JEV_COLUMN: Column = {
  key: 'jev',
  label: 'JEV',
  align: 'left',
  first: 'desc',
  value: (_r, jev) => jev?.agree_count ?? -1,
  tip: { title: 'Why JEV can disagree', steps: [JEV_WHY] },
}

function compare(a: number | string, b: number | string): number {
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
}

// ---------- view ----------

export function ScoresView() {
  const [rows, setRows] = useState<ScoreRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [opinion, setOpinion] = useState<SecondOpinion | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: 'priority', dir: 'desc' })
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState<Region | ''>('')
  const [band, setBand] = useState<Band | ''>('')
  const [whatIf, setWhatIf] = useState(false)

  useEffect(() => {
    const ctl = new AbortController()
    fetchSecondOpinion(ctl.signal).then((o) => {
      if (!ctl.signal.aborted) setOpinion(o)
    })
    return () => ctl.abort()
  }, [])

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

  // Narrow screens: the JEV column collapses into a compact badge next to the hub name.
  const narrow = useMediaQuery('(max-width: 639px)')
  const jevColumn = opinion !== null && !narrow
  const jevByHub = useMemo(() => new Map(opinion?.hubs.map((h) => [h.hub_id, h]) ?? []), [opinion])
  const columns = jevColumn ? [...COLUMNS, JEV_COLUMN] : COLUMNS

  const filtered = useMemo(() => {
    if (!rows) return null
    const q = query.trim().toLowerCase()
    return rows.filter((r) => (!region || r.region === region) && (!band || r.exposure_band === band) && (!q || r.name.toLowerCase().includes(q)))
  }, [rows, query, region, band])

  const shown = useMemo(() => {
    if (!filtered) return null
    const col = [...COLUMNS, JEV_COLUMN].find((c) => c.key === sort.key)!
    const sign = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort(
      (a, b) => sign * compare(col.value(a, jevByHub.get(a.hub_id)), col.value(b, jevByHub.get(b.hub_id))) || a.hub_id.localeCompare(b.hub_id),
    )
  }, [filtered, sort, jevByHub])

  const filtersOn = query !== '' || region !== '' || band !== ''
  const reset = () => {
    setQuery('')
    setRegion('')
    setBand('')
  }
  const toggleSort = (c: Column) => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.first }))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <h1 className="heading-tight text-2xl font-semibold tracking-tight">All hubs</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Lost days are the weather-disruption days a hub can expect, in a typical year and in the worst 1 year in 20. Investment priority shows where
          upgrades would help most.
          {USE_MOCKS && ' Mock mode: showing recorded snapshot scores.'}
        </p>

        {opinion && <SecondOpinionSummary opinion={opinion} onRerun={setOpinion} />}

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant={whatIf ? 'secondary' : 'outline'} size="sm" aria-expanded={whatIf} onClick={() => setWhatIf((v) => !v)}>
            <SlidersHorizontalIcon />
            What if
          </Button>
          <Button variant="outline" size="sm" onClick={() => shown && exportCsv(shown)} disabled={!shown || shown.length === 0}>
            <DownloadIcon />
            Export CSV
          </Button>
        </div>
        {whatIf && rows && <WhatIfPanel rows={rows} />}

        <Filters
          query={query}
          region={region}
          band={band}
          onQuery={setQuery}
          onRegion={setRegion}
          onBand={setBand}
          onReset={reset}
          active={filtersOn}
          count={shown ? `Showing ${shown.length} of ${rows?.length ?? 0} hubs` : ''}
        />

        {error && (
          <div className="mt-4 flex flex-wrap items-center gap-3 rounded-2xl bg-band-high-soft px-4 py-3 text-sm text-band-high-text" role="alert">
            Scores could not be loaded ({error}).
            <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        )}
        {!shown && !error && (
          <div className="mt-4 space-y-2" aria-label="Loading scores">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        )}

        {shown && (
          <div className="glass mt-4 max-h-[calc(100dvh-15rem)] min-h-64 overflow-auto rounded-3xl">
            <table className={`w-full border-separate border-spacing-0 text-sm ${jevColumn ? 'min-w-[920px]' : 'min-w-[760px]'}`}>
              <thead>
                <tr>
                  <th scope="col" className="sticky top-0 z-10 w-10 border-b border-border bg-header px-3 py-2.5 text-left align-bottom text-xs font-semibold text-muted-foreground">
                    #
                  </th>
                  {columns.map((c) => (
                    <SortHeader key={c.key} column={c} sort={sort} onSort={() => toggleSort(c)} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => {
                  const jev = jevByHub.get(r.hub_id)
                  return (
                    <tr key={r.hub_id} className="even:bg-foreground/[0.025] hover:bg-isobar/[0.05]">
                      <td className="border-b border-border/50 px-3 py-2.5 text-muted-foreground tabular-nums">{i + 1}</td>
                      <th scope="row" className="border-b border-border/50 px-3 py-2.5 text-left font-semibold">
                        <span className="inline-flex items-center gap-1.5">
                          <span>
                            {shortHubName(r.name)}
                            <span className="block text-xs font-normal text-muted-foreground">{r.region}</span>
                          </span>
                          {opinion && narrow && jev && <SecondOpinionCell hub={jev} />}
                        </span>
                      </th>
                      <Num>
                        <Metered text={`${fmt(r.exposure_days_per_year)} d`} meter={r.exposure} band={r.exposure_band} />
                      </Num>
                      <Num>
                        <span className="font-semibold">{fmt(r.bad_year_days)} d</span>
                      </Num>
                      <Num>{pct(r.hurricane_10yr_probability_pct)}</Num>
                      <Num>
                        <Metered text={fmt(r.priority)} meter={r.priority} band={r.priority_band} />
                      </Num>
                      <td className="border-b border-border/50 px-3 py-2.5 text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <HazardIcon hazard={r.top_driver} />
                          {FAMILY_LABEL[r.top_driver]}
                        </span>
                      </td>
                      {jevColumn && (
                        <td className="border-b border-border/50 px-3 py-2.5">
                          {jev ? <SecondOpinionCell hub={jev} /> : <span className="text-muted-foreground">Not rated</span>}
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
            {shown.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">No hubs match these filters.</p>}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Header cell, in a fixed order for every column: label, (i), sort arrow, on one baseline.
 * Right-aligned (numeric) columns right-align the whole group over the numbers; the order never flips.
 */
function SortHeader({ column, sort, onSort }: { column: Column; sort: { key: SortKey; dir: Dir }; onSort: () => void }) {
  const active = sort.key === column.key
  const Arrow = !active ? ChevronsUpDownIcon : sort.dir === 'asc' ? ArrowUpIcon : ArrowDownIcon
  const right = column.align === 'right'
  const tone = active ? 'text-foreground' : 'text-muted-foreground'
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`sticky top-0 z-10 border-b border-border bg-header px-3 py-2 align-bottom text-xs font-semibold whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}
    >
      {/* gap-0.5 + the (i) button's own inset gives about 5 px between label, icon and arrow. */}
      <span data-header-group className="inline-flex items-center gap-0.5 align-middle">
        <button
          type="button"
          onClick={onSort}
          aria-label={`Sort by ${column.label}`}
          className={`rounded-md py-1 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none ${tone}`}
        >
          {column.label}
        </button>
        <InfoTip subject={column.label} title={column.tip.title} steps={column.tip.steps} />
        {/* The arrow sorts too (pointer only; the label button is the keyboard target). */}
        <span data-sort-arrow aria-hidden="true" onClick={onSort} className={`cursor-pointer ${tone}`}>
          <Arrow className={`size-3.5 ${active ? '' : 'opacity-40'}`} />
        </span>
      </span>
    </th>
  )
}

function Num({ children }: { children: ReactNode }) {
  return <td className="border-b border-border/50 px-3 py-2.5 text-right tabular-nums">{children}</td>
}

/** Right-aligned value with the 0-100 band ruler and band word underneath. */
function Metered({ text, meter, band }: { text: string; meter: number; band: Band }) {
  return (
    <span className="inline-flex flex-col items-end gap-1">
      <span className="font-semibold whitespace-nowrap">{text}</span>
      <span className="flex w-28 items-center gap-2">
        <BandMeter value={meter} band={band} />
        <span className="w-12 shrink-0 text-right">
          <BandText band={band} />
        </span>
      </span>
    </span>
  )
}

function Filters(props: {
  query: string
  region: Region | ''
  band: Band | ''
  onQuery: (v: string) => void
  onRegion: (v: Region | '') => void
  onBand: (v: Band | '') => void
  onReset: () => void
  active: boolean
  count: string
}) {
  const select =
    'h-9 rounded-xl border border-border/70 bg-background/70 px-2.5 text-sm text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none'
  return (
    <div className="mt-5 flex flex-wrap items-end gap-x-3 gap-y-2">
      <label className="relative flex min-w-48 flex-1 basis-56 flex-col gap-1 text-xs text-muted-foreground sm:flex-none">
        <span className="sr-only">Search hubs</span>
        <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4" aria-hidden="true" />
        <input
          type="search"
          value={props.query}
          onChange={(e) => props.onQuery(e.target.value)}
          placeholder="Search hubs"
          aria-label="Search hubs"
          className={`${select} pl-8`}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Region
        <SelectPill aria-label="Region" value={props.region} onChange={(e) => props.onRegion(e.target.value as Region | '')}>
          <option value="">All regions</option>
          {REGIONS.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </SelectPill>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        Exposure band
        <SelectPill aria-label="Exposure band" value={props.band} onChange={(e) => props.onBand(e.target.value as Band | '')}>
          <option value="">All bands</option>
          {BANDS.map((b) => (
            <option key={b} value={b}>
              {b[0].toUpperCase() + b.slice(1)}
            </option>
          ))}
        </SelectPill>
      </label>
      <Button variant="ghost" size="sm" className="h-9" onClick={props.onReset} disabled={!props.active}>
        Reset filters
      </Button>
      <span className="ml-auto self-center text-xs text-muted-foreground" aria-live="polite">
        {props.count}
      </span>
    </div>
  )
}

/** One line above the table, rank agreement per hazard, plus the developer-only re-run. */
function SecondOpinionSummary({ opinion, onRerun }: { opinion: SecondOpinion; onRerun: (o: SecondOpinion) => void }) {
  const debug = useDebug()
  const [running, setRunning] = useState(false)
  const [detail, setDetail] = useState<string | null>(null)
  const ranks = opinion.rank_correlation ? FAMILIES.filter((f) => typeof opinion.rank_correlation?.[f] === 'number') : []

  async function rerun() {
    setRunning(true)
    setDetail(null)
    const result = await rerunSecondOpinion()
    setRunning(false)
    if (result.ok) onRerun(result.opinion)
    else setDetail(result.detail)
  }

  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
      <div className="min-w-0 flex-1 basis-80 text-muted-foreground">
        <p className="flex items-start gap-1">
          <span>
            <span className="text-foreground">
              JEV agrees with the formula on {opinion.agree_count} of {opinion.total} ratings ({opinion.agreement_pct}%).
            </span>{' '}
            Run {formatDate(opinion.run_at)} on data as of {formatDate(opinion.data_as_of)}.
            {debug && <span className="ml-1 text-xs">Model: {opinion.model}.</span>}
          </span>
          <InfoTip subject="JEV second opinion" title="About the JEV second opinion" steps={[JEV_ABOUT, JEV_WHY]} />
        </p>
        {ranks.length > 0 && (
          <p role="group" aria-label="Rank agreement by hazard" className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span>Rank agreement (1 means the same order):</span>
            {ranks.map((f) => (
              <span key={f} className="inline-flex items-center gap-1 whitespace-nowrap">
                <HazardIcon hazard={f} className="size-3.5" />
                {FAMILY_LABEL[f]} <span className="font-semibold text-foreground tabular-nums">{opinion.rank_correlation![f]}</span>
              </span>
            ))}
          </p>
        )}
      </div>
      {debug && (
        <Button variant="outline" size="sm" onClick={rerun} disabled={running} aria-busy={running}>
          {running && <Spinner />}
          {running ? 'Re-running JEV…' : 'Re-run JEV'}
        </Button>
      )}
      {detail && (
        <p className="basis-full text-xs text-band-high-text" role="status">
          {detail}
        </p>
      )}
    </div>
  )
}

/** The table as shown (filters and sort applied), one row per hub. */
function exportCsv(rows: ScoreRow[]) {
  const header = [
    'Rank',
    'Hub',
    'Region',
    'Typical year (lost days)',
    'Bad year (lost days)',
    'Hurricane 10-yr chance (%)',
    'Investment priority',
    'Priority band',
    'Exposure band',
    'Top driver',
  ]
  const body = rows.map((r, i) => [
    i + 1,
    shortHubName(r.name),
    r.region,
    r.exposure_days_per_year,
    r.bad_year_days,
    r.hurricane_10yr_probability_pct,
    r.priority,
    r.priority_band,
    r.exposure_band,
    FAMILY_LABEL[r.top_driver],
  ])
  downloadCsv(`hub-scores-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...body])
}
