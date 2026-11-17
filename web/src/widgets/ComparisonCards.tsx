// Hub comparison (compare_hubs): one aligned table. Row labels carry the units; one equal-width column per hub;
// numbers right-aligned with tabular digits; the highest value in each numeric row is highlighted.
// Narrow screens keep the same table and scroll sideways with the label column pinned, so rows never break apart.
import type { ReactNode } from 'react'
import { HazardIcon } from '@/components/HazardIcon'
import { ReadingGuide } from '@/components/ReadingGuide'
import { FAMILY_LABEL, HAZARD_LABEL, fmt, formatDate, hubName, isNum } from '@/lib/format'
import type { Band, Hazard, HubComparison, HubScore } from '@/lib/types'
import { hubDetail, readingGuide } from '@/lib/explain'
import { BandPill, WidgetFrame } from './WidgetFrame'
import { normalizeComparison } from '@/lib/normalize'

type Row =
  | { kind: 'number'; label: string; value: (s: HubScore) => number | null | undefined }
  | { kind: 'level'; label: string; value: (s: HubScore) => Band | null | undefined }
  | { kind: 'risk'; label: string }

const FIXED_ROWS: Row[] = [
  { kind: 'number', label: 'Typical year (days/yr)', value: (s) => s.exposure_days_per_year },
  { kind: 'number', label: 'Bad year (days/yr)', value: (s) => s.bad_year_days },
  { kind: 'number', label: 'Exposure score (0-100)', value: (s) => s.exposure },
  { kind: 'level', label: 'Exposure level', value: (s) => s.exposure_band },
  { kind: 'number', label: 'Screening priority (0-100)', value: (s) => s.priority },
  { kind: 'level', label: 'Priority level', value: (s) => s.priority_band },
  { kind: 'risk', label: 'Biggest risk' },
]

/** The hazards the question asked about, after the fixed rows (the answer cites them, so the table shows them too). */
function hazardRows(hazards: Hazard[]): Row[] {
  return hazards
    .filter((h): h is Exclude<Hazard, 'overall'> => h !== 'overall')
    .map((h) =>
      h === 'hurricane'
        ? { kind: 'number', label: 'Hurricane, 10-yr chance (%)', value: (s: HubScore) => s.hurricane_10yr_probability_pct }
        : { kind: 'number', label: `${HAZARD_LABEL[h]} (days/yr)`, value: (s: HubScore) => s.families[h]?.days_per_year },
    )
}

const LEVEL_RANK: Record<Band, number> = { low: 0, medium: 1, high: 2 }

/** "High exposure but Medium priority" (or any exposure level above the priority level). */
export function exposureAbovePriority(s: Pick<HubScore, 'exposure_band' | 'priority_band'>): boolean {
  return Boolean(s.exposure_band && s.priority_band && LEVEL_RANK[s.exposure_band] > LEVEL_RANK[s.priority_band])
}

const cell = 'h-11 border-b border-border/50 px-2 align-middle sm:px-3'
const labelCell = `${cell} sticky left-0 z-[1] bg-card text-left text-xs font-normal text-muted-foreground`

export function ComparisonCards({ data: raw }: { data: HubComparison }) {
  const data = normalizeComparison(raw)
  const hubs = data.hubs
  const rows = [...FIXED_ROWS, ...hazardRows(data.hazards)]
  const t = hubs[0]?.band_thresholds
  const footer = hubs.some(exposureAbovePriority)

  return (
    <WidgetFrame
      label="Hub comparison"
      title={
        <span className="flex items-center gap-1">
          Comparing {hubs.length} hubs
          <ReadingGuide legend={readingGuide(t)} detail={hubs.flatMap((s) => [`${hubName(s.hub_id)}:`, ...hubDetail(s)])} />
        </span>
      }
      note={`Lost operating days a year from weather (modeled estimate). Highest in each row is highlighted. Data as of ${formatDate(data.data_as_of)}.`}
    >
      <div className="-mx-1 overflow-x-auto px-1" data-testid="compare-scroll">
        <table
          className="w-full table-fixed border-separate border-spacing-0 text-sm"
          style={{ minWidth: `calc(8rem + ${hubs.length} * 5rem)` }}
          aria-label={`Comparison of ${hubs.map((s) => hubName(s.hub_id)).join(', ')}`}
        >
          <colgroup>
            <col className="w-[40%] sm:w-[30%]" />
            {hubs.map((s) => (
              <col key={s.hub_id} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th scope="col" className={`${labelCell} h-9 align-bottom`}>
                <span className="sr-only">Measure</span>
              </th>
              {hubs.map((s) => (
                <th key={s.hub_id} scope="col" className={`${cell} h-9 truncate text-right align-bottom font-semibold`}>
                  {hubName(s.hub_id)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row" className={labelCell}>
                  <RowLabel label={row.label} />
                </th>
                {hubs.map((s) => (
                  <td key={s.hub_id} className={`${cell} text-right tabular-nums`} data-kind={row.kind}>
                    {renderCell(row, s, hubs)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && (
        <p className="mt-2.5 text-xs text-muted-foreground" data-testid="compare-footer">
          Why can a hub be High exposure but Medium priority? Priority also weighs people served and how well the area recovers.
        </p>
      )}
    </WidgetFrame>
  )
}

/** "Exposure score (0-100)": if the label wraps, the unit moves to the next line whole, never split at the hyphen. */
function RowLabel({ label }: { label: string }) {
  const m = /^(.*?)\s*(\([^)]*\))$/.exec(label)
  if (!m) return <>{label}</>
  return (
    <>
      {m[1]} <span className="whitespace-nowrap">{m[2]}</span>
    </>
  )
}

function renderCell(row: Row, s: HubScore, hubs: HubScore[]): ReactNode {
  if (row.kind === 'risk')
    return s.top_driver ? (
      <span className="inline-flex items-center justify-end gap-1.5 px-1.5">
        <HazardIcon hazard={s.top_driver} className="size-3.5" />
        {FAMILY_LABEL[s.top_driver]}
      </span>
    ) : (
      <span className="text-muted-foreground">n/a</span>
    )
  if (row.kind === 'level') {
    const level = row.value(s)
    return level ? <BandPill band={level} /> : <span className="text-muted-foreground">n/a</span>
  }
  const v = row.value(s)
  const values = hubs.map((h) => row.value(h)).filter(isNum)
  const max = values.length > 1 ? Math.max(...values) : null
  // Highlight the row maximum, unless every hub has the same value (nothing stands out).
  const top = isNum(v) && max !== null && v === max && values.some((x) => x !== max)
  return (
    // Same padding with or without the pill, so every number's right edge lines up.
    <span data-max={top || undefined} className={`rounded-md px-1.5 py-0.5 ${top ? 'bg-isobar-soft font-medium text-foreground' : ''}`}>
      {fmt(v)}
    </span>
  )
}
