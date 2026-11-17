import { FAMILY_LABEL, HAZARD_LABEL, fmt, hubName } from '@/lib/format'
import type { Hazard, HubComparison, HubScore } from '@/lib/types'
import { BandPill, WidgetFrame } from './WidgetFrame'

function hazardValue(s: HubScore, h: Hazard): { score: number; days: number } {
  if (h === 'overall') return { score: s.exposure, days: s.exposure_days_per_year }
  const f = s.families[h]
  return { score: f?.score ?? 0, days: f?.days_per_year ?? 0 }
}

export function ComparisonCards({ data }: { data: HubComparison }) {
  const hazards: Hazard[] = data.hazards.length ? data.hazards : ['overall']
  const best = (h: Hazard) => Math.max(...data.hubs.map((s) => hazardValue(s, h).score))
  const names = data.hubs.map((s) => hubName(s.hub_id))

  return (
    <WidgetFrame
      label="Hub comparison"
      title={names.length === 2 ? `${names[0]} and ${names[1]}` : `Comparing ${names.length} hubs`}
      note={`Higher score means more exposed. Data as of ${data.data_as_of}.`}
    >
      <div className="grid gap-3" style={{ gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, 200px), 1fr))` }}>
        {data.hubs.map((s) => (
          <div key={s.hub_id} className="rounded-xl bg-background/60 px-3.5 py-3 ring-1 ring-border/60">
            <p className="font-wide font-semibold">{hubName(s.hub_id)}</p>
            <p className="text-xs text-muted-foreground">Top driver: {FAMILY_LABEL[s.top_driver]}</p>
            <dl className="mt-2.5 space-y-2 text-sm">
              {hazards.map((h) => {
                const v = hazardValue(s, h)
                const lead = data.hubs.length > 1 && v.score === best(h)
                return (
                  <div key={h} className="flex items-baseline justify-between gap-2">
                    <dt className="text-muted-foreground">{h === 'overall' ? 'Overall exposure' : HAZARD_LABEL[h]}</dt>
                    <dd className="text-right">
                      <span className={`font-semibold ${lead ? 'text-band-high' : ''}`}>{fmt(v.score)}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{fmt(v.days)} d/yr</span>
                    </dd>
                  </div>
                )
              })}
              <div className="flex items-baseline justify-between gap-2 border-t border-border/60 pt-2">
                <dt className="text-muted-foreground">Exposure band</dt>
                <dd><BandPill band={s.exposure_band} /></dd>
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <dt className="text-muted-foreground">Investment priority</dt>
                <dd className="flex items-center gap-1.5">
                  <span className="font-semibold">{fmt(s.priority)}</span> <BandPill band={s.priority_band} />
                </dd>
              </div>
            </dl>
          </div>
        ))}
      </div>
      {data.hubs.length > 1 && <p className="mt-2 text-[0.7rem] text-muted-foreground">Red marks the higher score in each row.</p>}
    </WidgetFrame>
  )
}
