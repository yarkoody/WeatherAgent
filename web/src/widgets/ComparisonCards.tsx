// Hub comparison (compare_hubs): one row per hub, one sortable column per measure (click a header to sort, like the
// Scores table). A verdict line says which measure decides what: the exposure score decides which hub is more
// exposed, review priority decides which hubs to examine first. The highest (riskiest) value in each column is highlighted.
// Narrow screens scroll sideways with the hub column pinned; hub names wrap instead of being cut off.
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { HazardIcon } from '@/components/HazardIcon'
import { ReadingGuide } from '@/components/ReadingGuide'
import { FAMILY_LABEL, HAZARD_LABEL, compact, fmt, formatDate, hasPeople, hubName, isNum } from '@/lib/format'
import type { Band, Hazard, HubComparison, HubScore } from '@/lib/types'
import { PEOPLE_DAYS_LINE, hubDetail, readingGuide } from '@/lib/explain'
import { BandPill, WidgetFrame } from './WidgetFrame'
import { normalizeComparison } from '@/lib/normalize'

const LEVEL_RANK: Record<Band, number> = { low: 0, medium: 1, high: 2 }

interface Column {
  key: string
  /** Header text, with the unit underneath ("days/yr", "0-100"). */
  label: string
  unit?: string
  kind: 'number' | 'risk'
  /** The value used for sorting (and, for numbers, shown and highlighted). */
  value: (s: HubScore) => number | string | null | undefined
  /** This column decides a verdict (exposure or priority). */
  decides?: string
  /** The level shown as a chip beside the number (exposure and priority). */
  level?: (s: HubScore) => Band | null | undefined
  /** Display format for the number (default: one decimal). */
  format?: (v: number | null | undefined) => string
  /** A small second line under the number (e.g. the bad-year people-days). */
  sub?: (s: HubScore) => string | null
}

/** People impact columns, shown when the scores carry them (people served is a metro estimate, a proxy). */
const PEOPLE: Column[] = [
  {
    key: 'people',
    label: 'People served',
    unit: 'metro, est.',
    kind: 'number',
    value: (s) => (hasPeople(s) ? s.people_served : null),
    format: (v) => compact(v),
  },
  {
    key: 'people_days',
    label: 'People-days',
    unit: 'M/yr, typical · bad',
    kind: 'number',
    value: (s) => (hasPeople(s) ? s.people_days_m : null),
    sub: (s) => (hasPeople(s) && isNum(s.people_days_bad_year_m) ? `bad year ${fmt(s.people_days_bad_year_m)}` : null),
  },
]

const FIXED: Column[] = [
  { key: 'typical', label: 'Typical year', unit: 'days/yr', kind: 'number', value: (s) => s.exposure_days_per_year },
  { key: 'bad', label: 'Bad year', unit: 'days/yr', kind: 'number', value: (s) => s.bad_year_days },
  // The level sits beside its score in one cell ("Medium 54.7"): one column per decision, not two.
  {
    key: 'exposure',
    label: 'Exposure score',
    unit: '0-100, level',
    kind: 'number',
    value: (s) => s.exposure,
    level: (s) => s.exposure_band,
    decides: 'Decides which hub is more exposed',
  },
  {
    key: 'priority',
    label: 'Review priority',
    unit: 'typical yr, 0-100, level',
    kind: 'number',
    value: (s) => s.priority,
    level: (s) => s.priority_band,
    // The bad year beside it, so a hub with a low typical priority (Miami, Houston) never reads as safe.
    sub: (s) => (isNum(s.bad_year_days) ? `bad year ${fmt(s.bad_year_days)} days` : null),
    decides: 'Decides which hubs to examine first',
  },
  { key: 'risk', label: 'Biggest risk', kind: 'risk', value: (s) => (s.top_driver ? FAMILY_LABEL[s.top_driver] : null) },
]

/** The hazards the question asked about, after the fixed columns (the answer cites them, so the table shows them too). */
function hazardColumns(hazards: Hazard[]): Column[] {
  return hazards
    .filter((h): h is Exclude<Hazard, 'overall'> => h !== 'overall')
    .map((h): Column =>
      h === 'hurricane'
        ? { key: h, label: 'Hurricane', unit: '10-yr chance, %', kind: 'number', value: (s) => s.hurricane_10yr_probability_pct }
        : { key: h, label: HAZARD_LABEL[h], unit: 'days/yr', kind: 'number', value: (s) => s.families[h]?.days_per_year },
    )
}

/** "High exposure but Medium priority" (or any exposure level above the priority level). */
export function exposureAbovePriority(s: Pick<HubScore, 'exposure_band' | 'priority_band'>): boolean {
  return Boolean(s.exposure_band && s.priority_band && LEVEL_RANK[s.exposure_band] > LEVEL_RANK[s.priority_band])
}

/** "More exposed: Dallas (exposure score 54.7 vs 42)." from the deciding columns; a tie says so. */
export function verdict(hubs: HubScore[]): string[] {
  if (hubs.length < 2) return []
  const line = (what: string, measure: string, get: (s: HubScore) => number) => {
    const sorted = [...hubs].filter((s) => isNum(get(s))).sort((a, b) => get(b) - get(a))
    if (sorted.length < 2) return null
    const [top, next] = sorted
    if (get(top) === get(next)) return `${what}: a tie on ${measure} (${fmt(get(top))}).`
    const rest = sorted
      .slice(1)
      .map((s) => fmt(get(s)))
      .join(', ')
    return `${what}: ${hubName(top.hub_id)} (${measure} ${fmt(get(top))} vs ${rest}).`
  }
  return [line('More exposed', 'exposure score', (s) => s.exposure), line('Higher review priority', 'priority', (s) => s.priority)].filter(
    (l): l is string => l !== null,
  )
}

type Sort = { key: string; dir: 'asc' | 'desc' }

const cell = 'h-11 border-b border-border/50 px-2 align-middle'
const pinned = 'sticky left-0 z-[1] bg-card'

export function ComparisonCards({ data: raw }: { data: HubComparison }) {
  const data = normalizeComparison(raw)
  const withPeople = data.hubs.some(hasPeople)
  const columns = [...FIXED, ...(withPeople ? PEOPLE : []), ...hazardColumns(data.hazards)]
  // Default: most exposed first, the verdict's own order.
  const [sort, setSort] = useState<Sort>({ key: 'exposure', dir: 'desc' })
  const col = columns.find((c) => c.key === sort.key) ?? FIXED[2]
  const sign = sort.dir === 'desc' ? -1 : 1
  const hubs = [...data.hubs].sort((a, b) => {
    const x = col.value(a)
    const y = col.value(b)
    if (x == null || y == null) return x == null && y == null ? a.hub_id.localeCompare(b.hub_id) : x == null ? 1 : -1 // missing last
    const d = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))
    return sign * d || a.hub_id.localeCompare(b.hub_id)
  })
  const t = data.hubs[0]?.band_thresholds
  const footer = data.hubs.some(exposureAbovePriority)
  const lines = verdict(data.hubs)
  const toggle = (c: Column) =>
    setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: c.key, dir: c.kind === 'risk' ? 'asc' : 'desc' }))

  return (
    <WidgetFrame
      label="Hub comparison"
      title={
        <span className="flex items-center gap-1">
          Comparing {data.hubs.length} hubs
          <ReadingGuide legend={readingGuide(t)} detail={data.hubs.flatMap((s) => [`${hubName(s.hub_id)}:`, ...hubDetail(s)])} />
        </span>
      }
      note={`Lost operating days a year from weather (modeled estimate). Data as of ${formatDate(data.data_as_of)}.`}
    >
      {lines.length > 0 && (
        <div className="mb-3 space-y-0.5 text-sm" data-testid="compare-verdict">
          {lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
      )}
      <div className="-mx-1 overflow-x-auto px-1" data-testid="compare-scroll">
        <table
          className="w-full border-separate border-spacing-0 text-sm"
          style={{ minWidth: `calc(7rem + ${columns.length} * 5.25rem)` }}
          aria-label={`Comparison of ${data.hubs.map((s) => hubName(s.hub_id)).join(', ')}`}
        >
          <thead>
            <tr>
              <th scope="col" className={`${cell} ${pinned} w-28 text-left align-bottom text-xs font-semibold text-muted-foreground`}>
                Hub
              </th>
              {columns.map((c) => (
                <SortHeader key={c.key} column={c} sort={sort} onSort={() => toggle(c)} />
              ))}
            </tr>
          </thead>
          <tbody>
            {hubs.map((s) => (
              <tr key={s.hub_id}>
                {/* Names wrap instead of being cut off with an ellipsis. */}
                <th scope="row" className={`${cell} ${pinned} text-left font-semibold break-words`}>
                  {hubName(s.hub_id)}
                </th>
                {columns.map((c) => (
                  <td key={c.key} data-kind={c.kind} data-column={c.key} className={`${cell} ${c.kind === 'risk' ? 'text-left' : 'text-right'} tabular-nums`}>
                    {renderCell(c, s, data.hubs)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2.5 text-xs leading-relaxed text-muted-foreground" data-testid="compare-caption">
        <span className="rounded-md bg-isobar-soft px-1.5 py-0.5 font-medium text-foreground">Highlighted</span> = the highest, riskiest value in each
        column. Click a column header to sort. Exposure score decides which hub is more exposed; review priority decides which hubs to examine first.
      </p>
      {withPeople && (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="compare-people">
          {PEOPLE_DAYS_LINE} People served is the metro-area population, an estimate, not the hub&apos;s customers.
        </p>
      )}
      {footer && (
        <p className="mt-1.5 text-xs text-muted-foreground" data-testid="compare-footer">
          Why can a hub be High exposure but Medium priority? Priority also weighs people served and how well the area recovers.
        </p>
      )}
    </WidgetFrame>
  )
}

/** Measure header: the label (unit underneath) is the sort button, then the direction arrow; deciding columns say so. */
function SortHeader({ column, sort, onSort }: { column: Column; sort: Sort; onSort: () => void }) {
  const active = sort.key === column.key
  const Arrow = !active ? ChevronsUpDownIcon : sort.dir === 'asc' ? ArrowUpIcon : ArrowDownIcon
  const right = column.kind !== 'risk'
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      data-decides={column.decides ? 'true' : undefined}
      className={`${cell} align-bottom text-xs font-semibold ${right ? 'text-right' : 'text-left'} ${active ? 'text-foreground' : 'text-muted-foreground'}`}
    >
      <button
        type="button"
        onClick={onSort}
        aria-label={`Sort hubs by ${column.label}`}
        title={column.decides}
        className={`inline-flex items-end gap-1 rounded-md py-1 hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none ${right ? 'text-right' : 'text-left'}`}
      >
        <span>
          <span>{column.label}</span>
          {column.unit && <span className="block font-normal text-muted-foreground">{column.unit}</span>}
        </span>
        <Arrow className={`mb-0.5 size-3.5 shrink-0 ${active ? '' : 'opacity-40'}`} aria-hidden="true" />
      </button>
    </th>
  )
}

function renderCell(c: Column, s: HubScore, hubs: HubScore[]): ReactNode {
  if (c.kind === 'risk')
    return s.top_driver ? (
      <span className="inline-flex items-center gap-1.5">
        <HazardIcon hazard={s.top_driver} className="size-3.5" />
        {FAMILY_LABEL[s.top_driver]}
      </span>
    ) : (
      <span className="text-muted-foreground">n/a</span>
    )
  const v = c.value(s) as number | null | undefined
  const values = hubs.map((h) => c.value(h)).filter(isNum)
  const max = values.length > 1 ? Math.max(...values) : null
  // Highlight the column maximum, unless every hub has the same value (nothing stands out).
  const top = isNum(v) && max !== null && v === max && values.some((x) => x !== max)
  const number = (
    // Same padding with or without the pill, so every number's right edge lines up.
    <span data-max={top || undefined} className={`rounded-md px-1.5 py-0.5 ${top ? 'bg-isobar-soft font-medium text-foreground' : ''}`}>
      {(c.format ?? fmt)(v)}
    </span>
  )
  const level = c.level?.(s)
  const main = level ? (
    <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap">
      <span data-level={level}>
        <BandPill band={level} />
      </span>
      {number}
    </span>
  ) : (
    number
  )
  const sub = c.sub?.(s)
  return sub ? (
    <span className="inline-flex flex-col items-end leading-tight">
      {main}
      <span data-sub className="px-1.5 text-[0.7rem] whitespace-nowrap text-muted-foreground">
        {sub}
      </span>
    </span>
  ) : (
    main
  )
}
