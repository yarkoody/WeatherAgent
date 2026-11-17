import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, DownloadIcon, MapPinIcon, SearchIcon, SlidersHorizontalIcon } from 'lucide-react'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useReducedMotion } from '@/lib/motion'
import { provenanceLines, useProvenance, type Provenance } from '@/lib/provenance'
import { HowScoresWork } from '@/components/HowScoresWork'
import { lazyWithReload } from '@/lib/chunkReload'
import { HubBreakdown } from '@/widgets/HubBreakdown'
import { HazardIcon } from '@/components/HazardIcon'
import { InfoTip } from '@/components/InfoTip'
import { SelectPill } from '@/components/SelectPill'
import { WhatIfPanel } from '@/components/WhatIfPanel'
import { downloadCsv } from '@/lib/exportCsv'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { LOST_DAYS, PEOPLE_DAYS_LINE, PEOPLE_SERVED_DEF, REVIEW_PRIORITY_MEANING } from '@/lib/explain'
import { BAND_COLOR, FAMILY_LABEL, compact, fmt, hasPeople, isNum, shortHubName } from '@/lib/format'
import { USE_MOCKS, apiFetch } from '@/lib/mockFetch'
import type { Band, Hub, HubScore, Region, ScoreRow } from '@/lib/types'

// The map (us-atlas TopoJSON + d3) loads on its own, after the table.
const HubMap = lazyWithReload(() => import('@/components/HubMap').then((m) => ({ default: m.HubMap })))
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

type SortKey = 'hub' | 'typical' | 'bad_year' | 'hurricane' | 'priority' | 'people' | 'people_days' | 'driver'
type Dir = 'asc' | 'desc'

interface Column {
  key: SortKey
  label: string
  /** Written-out unit, shown once in the header (cells hold bare numbers). */
  unit?: string
  /** Numbers are centered under their header (label, unit, value and level share one center line). */
  align: 'left' | 'center'
  /** Direction on first click: numbers start high-to-low, names start A to Z. */
  first: Dir
  tip: { title: string; steps: string[] }
  value: (r: ScoreRow) => number | string
}

const COLUMNS: Column[] = [
  { key: 'hub', label: 'Hub', align: 'left', first: 'asc', value: (r) => shortHubName(r.name), tip: { title: 'About hubs', steps: ['The 15 US logistics hubs, with their Census region.'] } },
  {
    key: 'typical',
    label: 'Typical year',
    unit: 'days/yr',
    align: 'center',
    first: 'desc',
    value: (r) => r.exposure_days_per_year,
    tip: {
      title: 'About the typical year',
      steps: [`Lost operating days: ${LOST_DAYS}`, 'Typical year: the average year, across all hazards. An estimate, not a forecast.', 'The bar is the 0 to 100 exposure score; the two marks are the medium and high cut-offs.'],
    },
  },
  {
    key: 'bad_year',
    label: 'Bad year',
    unit: 'days/yr',
    align: 'center',
    first: 'desc',
    value: (r) => r.bad_year_days,
    tip: { title: 'About the bad year', steps: ['The average of the worst 1 year in 20, in lost operating days (an estimate).', 'Averages hide rare, severe events such as hurricanes; this column shows them.'] },
  },
  {
    key: 'hurricane',
    label: 'Hurricane chance',
    unit: '10 yr, %',
    align: 'center',
    first: 'desc',
    value: (r) => r.hurricane_10yr_probability_pct,
    tip: {
      title: 'About the hurricane chance',
      steps: ['Chance of at least one hurricane-class event in the next 10 years.', 'Hurricanes are rare but severe, so they are judged by this chance rather than by average days.'],
    },
  },
  {
    key: 'priority',
    label: 'Review priority',
    unit: '0-100, typical yr',
    align: 'center',
    first: 'desc',
    value: (r) => r.priority,
    tip: { title: 'About review priority', steps: [REVIEW_PRIORITY_MEANING, 'It mixes the exposure score with people served and the resilience gap, computed before rounding.', 'It uses the typical year: a hub with a low priority can still have a bad bad year (see the Bad year column).'] },
  },
  {
    key: 'people',
    label: 'People served',
    unit: 'metro, est.',
    align: 'center',
    first: 'desc',
    value: (r) => (hasPeople(r) ? r.people_served! : -Infinity), // unknown sorts last
    tip: { title: 'About people served', steps: [`People served: ${PEOPLE_SERVED_DEF}`] },
  },
  {
    key: 'people_days',
    label: 'People-days',
    unit: 'M/yr',
    align: 'center',
    first: 'desc',
    value: (r) => (hasPeople(r) ? r.people_days_m! : -Infinity),
    tip: { title: 'About people-days', steps: [PEOPLE_DAYS_LINE, 'Typical year. Hover a value to see the bad year.'] },
  },
  {
    key: 'driver',
    label: 'Biggest risk',
    align: 'left',
    first: 'asc',
    value: (r) => FAMILY_LABEL[r.top_driver],
    tip: { title: 'About the biggest risk', steps: ['The hazard behind the most lost operating days in a typical year.'] },
  },
]

function compare(a: number | string, b: number | string): number {
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))
}

// ---------- view ----------

export function ScoresView() {
  const [rows, setRows] = useState<ScoreRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [sort, setSort] = useState<{ key: SortKey; dir: Dir }>({ key: 'priority', dir: 'desc' })
  const [query, setQuery] = useState('')
  const [region, setRegion] = useState<Region | ''>('')
  const [band, setBand] = useState<Band | ''>('')
  const [whatIf, setWhatIf] = useState(false)
  const provenance = useProvenance()
  const [hubs, setHubs] = useState<Hub[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<{ id: string; score: HubScore | null; error?: string } | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    apiFetch('/hubs', { signal: ctl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<Hub[]>) : null))
      .then((h) => h && setHubs(h))
      .catch(() => {}) // no map without hub locations; the table still works
    return () => ctl.abort()
  }, [])

  // Selecting a hub (map dot or Enter on it): highlight and scroll to its row, and open its breakdown.
  const select = useCallback((id: string) => {
    setSelected(id)
    setDetail({ id, score: null })
    apiFetch(`/hubs/${encodeURIComponent(id)}/score`)
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { detail?: string } | null)?.detail ?? `HTTP ${r.status}`)
        return r.json() as Promise<HubScore>
      })
      .then((score) => setDetail((d) => (d?.id === id ? { id, score } : d)))
      .catch((e: Error) => setDetail((d) => (d?.id === id ? { id, score: null, error: e.message } : d)))
  }, [])
  // Table → map: scroll up to the map, center and zoom on the hub's dot (one pulse), and open its panel.
  const reduced = useReducedMotion()
  const mapAnchor = useRef<HTMLDivElement>(null)
  const [mapFocus, setMapFocus] = useState<{ id: string; n: number } | null>(null)
  const showOnMap = useCallback(
    (id: string) => {
      select(id)
      setMapFocus((f) => ({ id, n: (f?.n ?? 0) + 1 }))
      mapAnchor.current?.scrollIntoView?.({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
    },
    [select, reduced],
  )
  const closeDetail = useCallback(() => {
    setSelected(null)
    setDetail(null)
  }, [])
  // "Show in table": the detail lives in the map panel, so the table row is reached on request only.
  const showInTable = useCallback((id: string) => {
    const row = document.getElementById(`hub-row-${id}`)
    row?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
    row?.querySelector<HTMLElement>('th')?.focus({ preventScroll: true })
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

  const columns = COLUMNS

  const filtered = useMemo(() => {
    if (!rows) return null
    const q = query.trim().toLowerCase()
    return rows.filter((r) => (!region || r.region === region) && (!band || r.exposure_band === band) && (!q || r.name.toLowerCase().includes(q)))
  }, [rows, query, region, band])

  const shown = useMemo(() => {
    if (!filtered) return null
    const col = COLUMNS.find((c) => c.key === sort.key)!
    const sign = sort.dir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => sign * compare(col.value(a), col.value(b)) || a.hub_id.localeCompare(b.hub_id))
  }, [filtered, sort])

  const filtersOn = query !== '' || region !== '' || band !== ''
  const reset = () => {
    setQuery('')
    setRegion('')
    setBand('')
  }
  const toggleSort = (c: Column) => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: c.key, dir: c.first }))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6">
        <h1 className="heading-tight text-2xl font-semibold tracking-tight">All hubs</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Modeled lost days (estimates) and review priority for 15 US logistics hubs, from a fixed data snapshot.
          {USE_MOCKS && ' Mock mode: showing recorded snapshot scores.'}
        </p>
        <HowScoresWork rows={rows} provenance={provenance} />

        {/* The map leads the page; a selected hub's breakdown opens as a panel docked inside the map frame. */}
        <div className="mt-4 scroll-mt-4" ref={mapAnchor} id="hub-map">
          {hubs && rows ? (
            <Suspense fallback={<Skeleton className="h-[50vh] min-h-[420px] w-full rounded-3xl sm:h-[60vh]" />}>
              <HubMap
                hubs={hubs}
                rows={rows}
                selected={selected}
                onSelect={select}
                onClose={closeDetail}
                panel={detail && <HubDetail detail={detail} onShowInTable={showInTable} />}
                panelTitle={detail ? `${hubs.find((h) => h.id === detail.id)?.city ?? detail.id} breakdown` : undefined}
                focusRequest={mapFocus}
              />
            </Suspense>
          ) : (
            <Skeleton className="h-[50vh] min-h-[420px] w-full rounded-3xl sm:h-[60vh]" aria-label="Loading map" />
          )}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant={whatIf ? 'secondary' : 'outline'} size="sm" aria-expanded={whatIf} onClick={() => setWhatIf((v) => !v)}>
            <SlidersHorizontalIcon />
            What if
          </Button>
          <Button variant="outline" size="sm" onClick={() => shown && exportCsv(shown, provenance)} disabled={!shown || shown.length === 0}>
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

        <div className="mt-4">
          {error && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl bg-band-high-soft px-4 py-3 text-sm text-band-high-text" role="alert">
              Scores could not be loaded ({error}).
              <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </div>
          )}
          {!shown && !error && (
            <div className="glass min-h-64 space-y-2 rounded-3xl p-3" aria-label="Loading scores">
              {Array.from({ length: 6 }, (_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          )}

          {shown && (
            <div className="glass max-h-[calc(100dvh-15rem)] min-h-64 overflow-auto rounded-3xl">
              <table className={`w-full border-separate border-spacing-0 text-sm min-w-[760px]`}>
                <thead>
                  <tr>
                    <th scope="col" className="sticky top-0 z-10 w-8 border-b border-border bg-header py-2.5 pl-2 align-bottom">
                      <span className="sr-only">Map</span>
                    </th>
                    <th scope="col" className="sticky top-0 z-10 w-7 border-b border-border bg-header px-1 py-2.5 text-left align-bottom text-xs font-semibold text-muted-foreground">
                      #
                    </th>
                    {columns.map((c) => (
                      <SortHeader key={c.key} column={c} sort={sort} onSort={() => toggleSort(c)} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r, i) => {
                    return (
                      <tr
                        key={r.hub_id}
                        id={`hub-row-${r.hub_id}`}
                        data-selected={selected === r.hub_id}
                        // The whole row shows the hub on the map (clicks on buttons and links inside keep their own job).
                        tabIndex={0}
                        aria-label={`${shortHubName(r.name)}: press Enter to show on the map`}
                        onClick={(e) => {
                          if ((e.target as HTMLElement).closest('button, a, input, select, [role="dialog"]')) return
                          showOnMap(r.hub_id)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && e.target === e.currentTarget) {
                            e.preventDefault()
                            showOnMap(r.hub_id)
                          }
                        }}
                        className="scroll-mt-12 cursor-pointer outline-none even:bg-foreground/[0.025] hover:bg-isobar/[0.05] focus-visible:bg-isobar/[0.08] focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset data-[selected=true]:bg-isobar/[0.12]"
                      >
                        <td className="border-b border-border/50 py-2.5 pl-2">
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  variant="ghost"
                                  size="icon-xs"
                                  aria-label={`Show ${shortHubName(r.name)} on the map`}
                                  onClick={() => showOnMap(r.hub_id)}
                                  className={selected === r.hub_id ? 'text-isobar' : 'text-muted-foreground'}
                                />
                              }
                            >
                              <MapPinIcon />
                            </TooltipTrigger>
                            <TooltipContent>Show on map</TooltipContent>
                          </Tooltip>
                        </td>
                        <td className="border-b border-border/50 px-1 py-2.5 text-muted-foreground tabular-nums">{i + 1}</td>
                        <th scope="row" tabIndex={-1} className="border-b border-border/50 px-2 py-2.5 text-left font-semibold outline-none focus-visible:ring-3 focus-visible:ring-ring/30">
                          {shortHubName(r.name)}
                          <span className="block text-xs font-normal text-muted-foreground">{r.region}</span>
                        </th>
                        <Num>
                          <Metered text={fmt(r.exposure_days_per_year)} meter={r.exposure} band={r.exposure_band} />
                        </Num>
                        <Num>
                          <span className="font-semibold">{fmt(r.bad_year_days)}</span>
                        </Num>
                        <Num>{fmt(r.hurricane_10yr_probability_pct)}</Num>
                        <Num>
                          <Metered text={fmt(r.priority)} meter={r.priority} band={r.priority_band} />
                        </Num>
                        <Num>{hasPeople(r) ? compact(r.people_served) : <span className="font-normal text-muted-foreground">n/a</span>}</Num>
                        <Num>
                          {hasPeople(r) ? (
                            <span
                              className="font-semibold"
                              title={isNum(r.people_days_bad_year_m) ? `Bad year: ${fmt(r.people_days_bad_year_m)} million people-days` : undefined}
                            >
                              {fmt(r.people_days_m)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">n/a</span>
                          )}
                        </Num>
                        <td className="border-b border-border/50 px-2 py-2.5 text-muted-foreground">
                          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                            <HazardIcon hazard={r.top_driver} />
                            {FAMILY_LABEL[r.top_driver]}
                          </span>
                        </td>
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
    </div>
  )
}

/** The selected hub's breakdown (GET /hubs/{id}/score), shown in the map panel. */
function HubDetail({ detail, onShowInTable }: { detail: { id: string; score: HubScore | null; error?: string }; onShowInTable: (id: string) => void }) {
  return (
    <div aria-live="polite">
      {detail.score ? (
        <HubBreakdown data={detail.score} />
      ) : detail.error ? (
        <p className="rounded-3xl bg-band-high-soft px-5 py-3.5 text-sm text-band-high-text" role="alert">
          The breakdown could not be loaded ({detail.error}).
        </p>
      ) : (
        <Skeleton className="h-72 w-full rounded-3xl" aria-label="Loading hub breakdown" />
      )}
      <Button variant="link" size="sm" className="mt-1 px-1" onClick={() => onShowInTable(detail.id)}>
        Show in table
      </Button>
    </div>
  )
}

/**
 * Header cell, in a fixed order for every column: label, then the unit, (i) and sort arrow on a small second line.
 * The label stands alone on its line, so in centered (numeric) columns it sits exactly over the centered values;
 * the order never flips.
 */
function SortHeader({ column, sort, onSort }: { column: Column; sort: { key: SortKey; dir: Dir }; onSort: () => void }) {
  const active = sort.key === column.key
  const Arrow = !active ? ChevronsUpDownIcon : sort.dir === 'asc' ? ArrowUpIcon : ArrowDownIcon
  const center = column.align === 'center'
  const tone = active ? 'text-foreground' : 'text-muted-foreground'
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={`sticky top-0 z-10 border-b border-border bg-header px-2 py-2 align-bottom text-xs font-semibold ${center ? 'text-center' : 'text-left'}`}
    >
      <span data-header-group className={`inline-flex flex-col gap-0.5 align-bottom ${center ? 'items-center' : 'items-start'}`}>
        <button
          type="button"
          onClick={onSort}
          aria-label={`Sort by ${column.label}`}
          className={`max-w-[6.5rem] rounded-md leading-tight hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none ${center ? 'text-center' : 'text-left'} ${tone}`}
        >
          {column.label}
        </button>
        {/* Second line: the unit written out once, then (i) and the sort arrow. */}
        <span className="inline-flex items-center gap-0.5 text-[0.65rem] font-normal whitespace-nowrap text-muted-foreground">
          {column.unit && <span>({column.unit})</span>}
          <InfoTip subject={column.label} title={column.tip.title} steps={column.tip.steps} />
          {/* The arrow sorts too (pointer only; the label button is the keyboard target). */}
          <span data-sort-arrow aria-hidden="true" onClick={onSort} className={`cursor-pointer ${tone}`}>
            <Arrow className={`size-3.5 ${active ? '' : 'opacity-40'}`} />
          </span>
        </span>
      </span>
    </th>
  )
}

function Num({ children }: { children: ReactNode }) {
  return <td className="border-b border-border/50 px-2 py-2.5 text-center tabular-nums">{children}</td>
}

/** Centered value with the 0-100 band ruler and band word underneath. */
function Metered({ text, meter, band }: { text: string; meter: number; band: Band }) {
  return (
    <span className="inline-flex flex-col items-center gap-1">
      <span className="font-semibold whitespace-nowrap">{text}</span>
      <span className="flex w-20 items-center gap-1.5">
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
        Exposure level
        <SelectPill aria-label="Exposure level" value={props.band} onChange={(e) => props.onBand(e.target.value as Band | '')}>
          <option value="">All levels</option>
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

/** The table as shown (filters and sort applied), one row per hub. */
function exportCsv(rows: ScoreRow[], provenance: Provenance | null) {
  const header = [
    'Rank',
    'Hub',
    'Region',
    'Typical year (days/yr)',
    'Bad year (days/yr)',
    'Hurricane chance (10 yr, %)',
    'Review priority (0-100, typical year)',
    'Priority level',
    'Exposure level',
    'People served (metro, estimate)',
    'People-days typical year (M/yr)',
    'People-days bad year (M/yr)',
    'Biggest risk',
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
    hasPeople(r) ? r.people_served! : '',
    hasPeople(r) ? r.people_days_m! : '',
    hasPeople(r) && isNum(r.people_days_bad_year_m) ? r.people_days_bad_year_m : '',
    FAMILY_LABEL[r.top_driver],
  ])
  // Sources after a blank row, one per line (units stay in the header).
  const sources = provenanceLines(provenance)
  const tail = sources.length ? [[], ['Data sources'], ...sources.map((l) => [l])] : []
  downloadCsv(`hub-scores-${new Date().toISOString().slice(0, 10)}.csv`, [header, ...body, ...tail])
}
