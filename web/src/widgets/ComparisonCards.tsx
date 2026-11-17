import { HazardIcon } from '@/components/HazardIcon'
import { FAMILY_LABEL, HAZARD_LABEL, fmt, formatDate, hubName } from '@/lib/format'
import type { Hazard, HubComparison, HubScore } from '@/lib/types'
import { InfoTip } from '@/components/InfoTip'
import {
  LENS_EXPLAINER,
  badYearLines,
  badYearSteps,
  exposureLines,
  exposureSteps,
  familyBandLine,
  familyLines,
  familySteps,
  indexLine,
  priorityLines,
  prioritySteps,
} from '@/lib/explain'
import { BandText, WidgetFrame } from './WidgetFrame'
import { normalizeComparison } from '@/lib/normalize'

function hazardValue(s: HubScore, h: Hazard): { score: number; days: number } {
  if (h === 'overall') return { score: s.exposure, days: s.exposure_days_per_year }
  const f = s.families[h]
  return { score: f?.score ?? 0, days: f?.days_per_year ?? 0 }
}

export function ComparisonCards({ data: raw }: { data: HubComparison }) {
  const data = normalizeComparison(raw)
  const hazards: Hazard[] = data.hazards.length ? data.hazards : ['overall']
  const best = (h: Hazard) => Math.max(...data.hubs.map((s) => hazardValue(s, h).score))
  const names = data.hubs.map((s) => hubName(s.hub_id))

  return (
    <WidgetFrame
      label="Hub comparison"
      title={names.length === 2 ? `${names[0]} and ${names[1]}` : `Comparing ${names.length} hubs`}
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
                <dd className="font-semibold">{fmt(s.exposure_days_per_year)} d</dd>
              </div>
              {typeof s.bad_year_days === 'number' && (
                <div>
                  <dt className="flex items-center gap-1 text-xs text-muted-foreground">
                    Bad year (1 in 20)
                    <InfoTip subject="typical and bad years" title="About typical and bad years" steps={badYearSteps(s)} detail={[LENS_EXPLAINER, ...badYearLines(s)]} />
                  </dt>
                  <dd className="font-semibold">{fmt(s.bad_year_days)} d</dd>
                </div>
              )}
            </dl>
            <dl className="mt-2.5 space-y-2 text-sm">
              {hazards.map((h) => {
                const v = hazardValue(s, h)
                const lead = data.hubs.length > 1 && v.score === best(h)
                return (
                  <div key={h} className="flex items-center justify-between gap-2">
                    <dt className="flex items-center gap-1 text-muted-foreground">
                      {h !== 'overall' && <HazardIcon hazard={h} className="size-3.5" />}
                      {h === 'overall' ? 'Exposure score' : HAZARD_LABEL[h]}
                      <InfoTip
                        subject={`${hubName(s.hub_id)} ${h === 'overall' ? 'exposure' : HAZARD_LABEL[h]} score`}
                        steps={h === 'overall' ? exposureSteps(s) : s.families[h] ? familySteps(s.families[h], s.band_thresholds) : []}
                        detail={
                          h === 'overall'
                            ? [...exposureLines(s), indexLine(s.band_thresholds)]
                            : s.families[h]
                              ? [...familyLines(s.families[h]), familyBandLine(s.band_thresholds)]
                              : []
                        }
                      />
                    </dt>
                    <dd className="text-right">
                      <span className={`font-semibold ${lead ? 'text-band-high' : ''}`}>{fmt(v.score)}</span>
                      <span className="ml-1.5 text-xs text-muted-foreground">{fmt(v.days)} d/yr</span>
                    </dd>
                  </div>
                )
              })}
              <div className="flex items-baseline justify-between gap-2 border-t border-border/60 pt-2">
                <dt className="text-muted-foreground">Exposure score band</dt>
                <dd>
                  <BandText band={s.exposure_band} />
                </dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="flex items-center gap-1 text-muted-foreground">
                  Screening priority
                  <InfoTip subject={`${hubName(s.hub_id)} screening priority`} steps={prioritySteps(s)} detail={priorityLines(s)} />
                </dt>
                <dd className="flex items-center gap-1.5">
                  <span className="font-semibold">{fmt(s.priority)}</span> <BandText band={s.priority_band} />
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
