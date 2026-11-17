import { HazardIcon } from '@/components/HazardIcon'
import { ReadingGuide } from '@/components/ReadingGuide'
import { FAMILY_LABEL, HAZARD_LABEL, fmt, formatDate, hubName, pct } from '@/lib/format'
import type { Band, Hazard, HubComparison, HubScore } from '@/lib/types'
import { hubDetail, readingGuide } from '@/lib/explain'
import { BandText, WidgetFrame } from './WidgetFrame'
import { normalizeComparison } from '@/lib/normalize'

/** What one hazard row shows: overall is the 0-100 score with its band; a hazard is its lost days with its band. */
function hazardRow(s: HubScore, h: Hazard): { rank: number; value: string; band: Band | null | undefined } {
  if (h === 'overall') return { rank: s.exposure, value: fmt(s.exposure), band: s.exposure_band }
  const f = s.families[h]
  if (h === 'hurricane' && typeof s.hurricane_10yr_probability_pct === 'number')
    return { rank: s.hurricane_10yr_probability_pct, value: `${pct(s.hurricane_10yr_probability_pct)} in 10 yrs`, band: f?.band }
  return { rank: f?.days_per_year ?? 0, value: `${fmt(f?.days_per_year)} days/yr`, band: f?.band }
}

/** "100 · High": the value, a real separator (so text never runs together), then the band word. */
function ValueBand({ value, band, lead }: { value: string; band: Band | null | undefined; lead?: boolean }) {
  return (
    <span className="whitespace-nowrap">
      <span className={`font-semibold tabular-nums ${lead ? 'text-band-high' : ''}`}>{value}</span>
      {band && (
        <>
          <span aria-hidden="true" className="text-muted-foreground">
            {' · '}
          </span>
          <BandText band={band} />
        </>
      )}
    </span>
  )
}

export function ComparisonCards({ data: raw }: { data: HubComparison }) {
  const data = normalizeComparison(raw)
  // The overall exposure score always leads; asked-about hazards follow.
  const hazards: Hazard[] = ['overall', ...data.hazards.filter((h) => h !== 'overall')]
  const best = (h: Hazard) => Math.max(...data.hubs.map((s) => hazardRow(s, h).rank))
  const names = data.hubs.map((s) => hubName(s.hub_id))
  const t = data.hubs[0]?.band_thresholds

  return (
    <WidgetFrame
      label="Hub comparison"
      title={
        <span className="flex items-center gap-1">
          {names.length === 2 ? `${names[0]} and ${names[1]}` : `Comparing ${names.length} hubs`}
          <ReadingGuide legend={readingGuide(t)} detail={data.hubs.flatMap((s) => [`${hubName(s.hub_id)}:`, ...hubDetail(s)])} />
        </span>
      }
      note={`More modeled lost days means more exposed. Data as of ${formatDate(data.data_as_of)}.`}
    >
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 200px), 1fr))`,
        }}
      >
        {data.hubs.map((s) => (
          <div key={s.hub_id} role="group" aria-label={hubName(s.hub_id)} className="rounded-2xl bg-background/60 px-4 py-3.5 ring-1 ring-border/60">
            <p className="heading-tight font-semibold">{hubName(s.hub_id)}</p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              Top driver: {s.top_driver ? <><HazardIcon hazard={s.top_driver} className="size-3.5" /> {FAMILY_LABEL[s.top_driver]}</> : 'n/a'}
            </p>
            <dl className="mt-2.5 grid grid-cols-2 gap-2 border-b border-border/60 pb-2.5 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Typical year</dt>
                <dd className="font-semibold tabular-nums">{fmt(s.exposure_days_per_year)} days/yr</dd>
              </div>
              {typeof s.bad_year_days === 'number' && (
                <div>
                  <dt className="text-xs text-muted-foreground">Bad year (1 in 20)</dt>
                  <dd className="font-semibold tabular-nums">{fmt(s.bad_year_days)} days</dd>
                </div>
              )}
            </dl>
            <dl className="mt-2.5 space-y-2 text-sm">
              {hazards.map((h) => {
                const v = hazardRow(s, h)
                const lead = data.hubs.length > 1 && v.rank === best(h)
                return (
                  <div key={h} className="flex items-baseline justify-between gap-2">
                    <dt className="flex items-center gap-1 text-muted-foreground">
                      {h !== 'overall' && <HazardIcon hazard={h} className="size-3.5" />}
                      {h === 'overall' ? 'Exposure score' : HAZARD_LABEL[h]}
                    </dt>
                    <dd className="text-right">
                      <ValueBand value={v.value} band={v.band} lead={lead} />
                    </dd>
                  </div>
                )
              })}
              <div className="flex items-baseline justify-between gap-2 border-t border-border/60 pt-2">
                <dt className="text-muted-foreground">Screening priority</dt>
                <dd>
                  <ValueBand value={fmt(s.priority)} band={s.priority_band} />
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
      {data.hubs.length > 1 && <p className="mt-2 text-[0.7rem] text-muted-foreground">Red marks the more exposed hub in each row.</p>}
    </WidgetFrame>
  )
}
