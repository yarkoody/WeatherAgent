import { Bar, BarChart, ReferenceLine, XAxis, YAxis } from 'recharts'
import { InfoTip } from '@/components/InfoTip'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import {
  LENS_EXPLAINER,
  badYearLines,
  badYearSteps,
  exposureLines,
  exposureSteps,
  familyBandLine,
  familyLines,
  familySteps,
  hurricaneLines,
  hurricaneSteps,
  indexLine,
  priorityLines,
  prioritySteps,
} from '@/lib/explain'
import { HazardIcon } from '@/components/HazardIcon'
import { ExportReportButton } from '@/components/PrintReport'
import { HubReport } from '@/components/reports'
import { Button } from '@/components/ui/button'
import { useAsk } from '@/lib/ask'
import { useMemo, useState } from 'react'
import { HistoryCharts } from './HistoryWidget'
import { BAND_COLOR, BAND_LABEL_COLOR, FAMILIES, FAMILY_COLOR, FAMILY_LABEL, fmt, formatDate, hubName, isNum, pct } from '@/lib/format'
import { normalizeHub } from '@/lib/normalize'
import { useCountUp, useReducedMotion } from '@/lib/motion'
import type { HubScore } from '@/lib/types'
import { BandText, WidgetFrame } from './WidgetFrame'

const config = {
  ...Object.fromEntries(FAMILIES.map((f) => [f, { label: FAMILY_LABEL[f], color: FAMILY_COLOR[f] }])),
  tail: { label: 'Extra in a bad year', color: '#7b8a95' },
} satisfies ChartConfig

function CountUp({ value }: { value: number }) {
  return <>{fmt(useCountUp(value))}</>
}

/** Typical year and bad year side by side; one (i) explains both. Saved pre-v2 data has no bad year. */
export function Lenses({ data: raw }: { data: HubScore }) {
  const data = useMemo(() => normalizeHub(raw), [raw])
  const number = 'heading-tight text-3xl leading-none font-semibold tracking-tight tabular-nums'
  return (
    <div className="flex items-end gap-x-7 gap-y-2">
      <div role="group" aria-label="Typical year">
        <p className={number}>
          <CountUp value={data.exposure_days_per_year} />
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">lost days in a typical year</p>
      </div>
      {typeof data.bad_year_days === 'number' && (
        <div role="group" aria-label="Bad year (1 in 20)">
          <p className={number}>
            <CountUp value={data.bad_year_days} />
          </p>
          <p className="mt-1.5 flex items-center gap-1 text-xs text-muted-foreground">
            in a bad year (1 in 20)
            <InfoTip
              subject="typical and bad years"
              title="About typical and bad years"
              steps={badYearSteps(data)}
              detail={[LENS_EXPLAINER, ...badYearLines(data)]}
            />
          </p>
        </div>
      )}
    </div>
  )
}

export function HubBreakdown({ data: raw }: { data: HubScore }) {
  const data = useMemo(() => normalizeHub(raw), [raw])
  const reduced = useReducedMotion()
  const t = data.band_thresholds
  const { days_cap: cap, medium_from_days: mediumDays, high_from_days: highDays } = t
  const hasBadYear = typeof data.bad_year_days === 'number'
  const hasHurricanePct = typeof data.hurricane_10yr_probability_pct === 'number'
  // With each hazard's share of the bad year (TVaR), draw two stacked rows: typical year and bad year.
  // Older data has only the hub total: draw the typical year with a hatched bad-year extension.
  const shares = hasBadYear && FAMILIES.every((f) => isNum(data.families[f]?.bad_year_days))
  const tail = hasBadYear && !shares && isNum(data.exposure_days_per_year) ? Math.max(0, data.bad_year_days - data.exposure_days_per_year) : 0
  const typicalRow = { lens: 'Typical', ...Object.fromEntries(FAMILIES.map((f) => [f, data.families[f]?.days_per_year ?? 0])), tail }
  const rows = shares
    ? [typicalRow, { lens: 'Bad year', ...Object.fromEntries(FAMILIES.map((f) => [f, data.families[f]!.bad_year_days!])), tail: 0 }]
    : [typicalRow]
  const height = shares ? 92 : 58
  const max = Math.max(...[cap, hasBadYear ? data.bad_year_days : 0, data.exposure_days_per_year].filter(isNum), 1)
  const cutoffs = isNum(mediumDays) && isNum(highDays)
  const name = hubName(data.hub_id)
  const [tab, setTab] = useState<'overview' | 'history'>('overview')

  return (
    <WidgetFrame label={`${name} risk breakdown`} title={`${name} risk breakdown`} note={`Data as of ${formatDate(data.data_as_of)}.`}>
      <div className="-mt-1 mb-3 flex items-center justify-between gap-2">
        <div role="tablist" aria-label={`${name} views`} className="inline-flex gap-1 rounded-xl bg-foreground/5 p-1">
          {(['overview', 'history'] as const).map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              id={`${data.hub_id}-tab-${v}`}
              aria-selected={tab === v}
              aria-controls={`${data.hub_id}-panel-${v}`}
              onClick={() => setTab(v)}
              className={`rounded-lg px-3 py-1 text-sm ${tab === v ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {v === 'overview' ? 'Overview' : 'History'}
            </button>
          ))}
        </div>
        <ExportReportButton report={() => <HubReport hub={data} />} />
      </div>
      {tab === 'history' ? (
        <div role="tabpanel" id={`${data.hub_id}-panel-history`} aria-labelledby={`${data.hub_id}-tab-history`}>
          <HistoryTab hubId={data.hub_id} name={name} />
        </div>
      ) : (
      <div role="tabpanel" id={`${data.hub_id}-panel-overview`} aria-labelledby={`${data.hub_id}-tab-overview`}>
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <Lenses data={data} />
        <dl className="flex gap-6 text-sm">
          <div>
            <dt className="flex items-center gap-1 text-xs text-muted-foreground">
              Exposure score
              <InfoTip subject="exposure score" steps={exposureSteps(data)} detail={[...exposureLines(data), indexLine(t)]} />
            </dt>
            <dd className="mt-0.5 flex items-baseline gap-1.5 font-semibold">
              {fmt(data.exposure)} <BandText band={data.exposure_band} />
            </dd>
          </div>
          <div>
            <dt className="flex items-center gap-1 text-xs text-muted-foreground">
              Investment priority
              <InfoTip subject="investment priority" steps={prioritySteps(data)} detail={priorityLines(data)} />
            </dt>
            <dd className="mt-0.5 flex items-baseline gap-1.5 font-semibold">
              {fmt(data.priority)} <BandText band={data.priority_band} />
            </dd>
          </div>
        </dl>
      </div>

      <ChartContainer config={config} className="mt-4 aspect-auto w-full" style={{ height }} initialDimension={{ width: 560, height }}>
        <BarChart data={rows} layout="vertical" margin={{ top: 16, right: 12, bottom: 0, left: 0 }} barCategoryGap={6} accessibilityLayer>
          <defs>
            <pattern id="bad-year-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--color-paper)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--color-ink-soft)" strokeWidth="1.5" />
            </pattern>
          </defs>
          <XAxis type="number" domain={[0, Math.ceil(max)]} hide />
          <YAxis type="category" dataKey="lens" hide={!shares} width={64} tickLine={false} axisLine={false} tick={{ fill: 'var(--muted-foreground)', fontSize: 11 }} />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                formatter={(v, key) =>
                  key === 'tail' ? `Extra in a bad year: ${fmt(Number(v))} days` : `${FAMILY_LABEL[key as keyof typeof FAMILY_LABEL]}: ${fmt(Number(v))} days/yr`
                }
              />
            }
          />
          {FAMILIES.map((f) => (
            <Bar
              key={f}
              dataKey={f}
              stackId="days"
              fill={`var(--color-${f})`}
              fillOpacity={f === data.top_driver ? 1 : 0.45}
              isAnimationActive={!reduced}
              animationDuration={400}
            />
          ))}
          <Bar dataKey="tail" stackId="days" fill="url(#bad-year-hatch)" radius={[0, 3, 3, 0]} isAnimationActive={!reduced} animationDuration={400} />
          {cutoffs && <ReferenceLine x={mediumDays} stroke={BAND_COLOR.medium} strokeDasharray="3 3" label={{ value: `${fmt(mediumDays, 2)} d`, position: 'top', fill: BAND_LABEL_COLOR.medium, fontSize: 10 }} />}
          {cutoffs && <ReferenceLine x={highDays} stroke={BAND_COLOR.high} strokeDasharray="3 3" label={{ value: `${fmt(highDays, 2)} d`, position: 'top', fill: BAND_LABEL_COLOR.high, fontSize: 10 }} />}
        </BarChart>
      </ChartContainer>
      <p className="text-[0.7rem] text-muted-foreground">
        Lost days by hazard{shares ? ', in a typical year and in the worst 1 year in 20' : ''}.{hasBadYear && !shares && ' Hatched: extra days in a bad year.'}
        {cutoffs && ` Dashed lines: medium band from ${fmt(mediumDays, 2)} days, high from ${fmt(highDays, 2)} days a year.`}
      </p>

      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
        {FAMILIES.map((f) => {
          const fam = data.families[f]
          if (!fam) return null
          const top = f === data.top_driver
          const isHurricane = f === 'hurricane' && hasHurricanePct
          return (
            <li key={f} aria-label={fam.band ? `${FAMILY_LABEL[f]}: ${fam.band} band` : FAMILY_LABEL[f]} data-band={fam.band} className="flex items-start gap-2">
              <HazardIcon hazard={f} className="mt-0.5 size-4" />
              <span className="min-w-0">
                <span className={`flex items-center gap-1 ${top ? 'font-semibold' : ''}`}>
                  {FAMILY_LABEL[f]}
                  <InfoTip
                    subject={`${FAMILY_LABEL[f]} band`}
                    icon={<HazardIcon hazard={f} />}
                    steps={isHurricane ? hurricaneSteps(data) : familySteps(fam, t)}
                    detail={[...(isHurricane ? hurricaneLines(data) : []), ...familyLines(fam), familyBandLine(t)]}
                  />
                </span>
                <span className="block text-xs text-muted-foreground">
                  {isHurricane ? `${pct(data.hurricane_10yr_probability_pct)} chance in 10 years` : `${fmt(fam.days_per_year)} lost days/yr`}
                  {typeof fam.bad_year_days === 'number' && `, ${fmt(fam.bad_year_days)} in a bad year`}
                  {fam.band && (
                    <>
                      {', '}
                      <BandText band={fam.band} />
                    </>
                  )}
                </span>
                {top && <span className="text-xs font-semibold text-isobar">Top driver</span>}
              </span>
            </li>
          )
        })}
      </ul>

      {data.upgrade_categories.length > 0 && (
        <p className="mt-4 border-t border-border/60 pt-3 text-sm text-muted-foreground">
          Upgrades that help most{data.top_driver ? ` against ${FAMILY_LABEL[data.top_driver].toLowerCase()}` : ''}:{' '}
          {data.upgrade_categories.map((u, i) => (
            <span key={u}>
              <span className="text-foreground">{u}</span>
              {i < data.upgrade_categories.length - 1 ? ', ' : '.'}
            </span>
          ))}
        </p>
      )}
      </div>
      )}
    </WidgetFrame>
  )
}

/** History tab: the observed history the agent fetched in this chat, or a button that asks for it. */
function HistoryTab({ hubId, name }: { hubId: string; name: string }) {
  const { ask, histories } = useAsk()
  const history = histories[hubId]
  if (history) return <HistoryCharts data={history} />
  return (
    <div className="flex flex-col items-start gap-2 py-2 text-sm text-muted-foreground">
      <p>Observed lost days per year and by month, from daily weather at the hub.</p>
      {ask ? (
        <Button variant="outline" size="sm" onClick={() => ask(`Show the observed weather history for ${name}.`)}>
          Show observed history
        </Button>
      ) : (
        <p>Ask in chat for the observed history of {name}.</p>
      )}
    </div>
  )
}
