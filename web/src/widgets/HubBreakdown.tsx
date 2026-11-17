import { Bar, BarChart, ReferenceLine, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { BAND_COLOR, FAMILIES, FAMILY_COLOR, FAMILY_LABEL, fmt, hubName } from '@/lib/format'
import type { HubScore } from '@/lib/types'
import { BandPill, WidgetFrame } from './WidgetFrame'

const config = Object.fromEntries(FAMILIES.map((f) => [f, { label: FAMILY_LABEL[f], color: FAMILY_COLOR[f] }])) satisfies ChartConfig

/** Days per year at which the exposure index reaches 100, derived from the tool's own numbers. */
export function exposureCap(s: HubScore): number {
  if (s.exposure > 0 && s.exposure < 100) return Math.round(((s.exposure_days_per_year * 100) / s.exposure) * 10) / 10
  return 25
}

export function HubBreakdown({ data }: { data: HubScore }) {
  const cap = exposureCap(data)
  const mediumDays = (cap * data.band_thresholds.medium_from) / 100
  const highDays = (cap * data.band_thresholds.high_from) / 100
  const row = Object.fromEntries(FAMILIES.map((f) => [f, data.families[f]?.days_per_year ?? 0]))
  const max = Math.max(cap, data.exposure_days_per_year)
  const name = hubName(data.hub_id)

  return (
    <WidgetFrame label={`${name} risk breakdown`} title={`${name} risk breakdown`} note={`Data as of ${data.data_as_of}.`}>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <p className="font-wide text-3xl leading-none font-semibold tracking-tight">{fmt(data.exposure_days_per_year)}</p>
          <p className="mt-1 text-xs text-muted-foreground">expected disruption days a year</p>
        </div>
        <dl className="flex gap-6 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Exposure index</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 font-semibold">
              {fmt(data.exposure)} <BandPill band={data.exposure_band} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Investment priority</dt>
            <dd className="mt-0.5 flex items-center gap-1.5 font-semibold">
              {fmt(data.priority)} <BandPill band={data.priority_band} />
            </dd>
          </div>
        </dl>
      </div>

      <ChartContainer config={config} className="mt-3 aspect-auto h-[58px] w-full" initialDimension={{ width: 560, height: 58 }}>
        <BarChart data={[row]} layout="vertical" margin={{ top: 16, right: 12, bottom: 0, left: 0 }} accessibilityLayer>
          <XAxis type="number" domain={[0, Math.ceil(max)]} hide />
          <YAxis type="category" hide />
          <ChartTooltip cursor={false} content={<ChartTooltipContent formatter={(v, name) => `${FAMILY_LABEL[name as keyof typeof FAMILY_LABEL]}: ${fmt(Number(v))} days/yr`} />} />
          {FAMILIES.map((f, i) => (
            <Bar
              key={f}
              dataKey={f}
              stackId="days"
              fill={`var(--color-${f})`}
              fillOpacity={f === data.top_driver ? 1 : 0.45}
              isAnimationActive={false}
              radius={i === FAMILIES.length - 1 ? [0, 3, 3, 0] : undefined}
            />
          ))}
          <ReferenceLine x={mediumDays} stroke={BAND_COLOR.medium} strokeDasharray="3 3" label={{ value: `${fmt(mediumDays)} d`, position: 'top', fill: BAND_COLOR.medium, fontSize: 10 }} />
          <ReferenceLine x={highDays} stroke={BAND_COLOR.high} strokeDasharray="3 3" label={{ value: `${fmt(highDays)} d`, position: 'top', fill: BAND_COLOR.high, fontSize: 10 }} />
        </BarChart>
      </ChartContainer>
      <p className="text-[0.7rem] text-muted-foreground">
        Dashed lines: medium band from {fmt(mediumDays)} days, high from {fmt(highDays)} days a year.
      </p>

      <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm sm:grid-cols-4">
        {FAMILIES.map((f) => {
          const fam = data.families[f]
          const top = f === data.top_driver
          return (
            <li key={f} className={`flex items-start gap-2 ${top ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
              <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: FAMILY_COLOR[f], opacity: top ? 1 : 0.45 }} aria-hidden="true" />
              <span>
                {FAMILY_LABEL[f]}
                <span className="block text-xs font-normal text-muted-foreground">
                  {fmt(fam?.days_per_year ?? 0)} days/yr, score {fmt(fam?.score ?? 0)}
                </span>
                {top && <span className="text-xs font-semibold text-isobar">Top driver</span>}
              </span>
            </li>
          )
        })}
      </ul>

      {data.upgrade_categories.length > 0 && (
        <div className="mt-3 border-t border-border/60 pt-2.5">
          <p className="text-xs text-muted-foreground">Upgrades that target {FAMILY_LABEL[data.top_driver].toLowerCase()} risk</p>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {data.upgrade_categories.map((u) => (
              <li key={u} className="rounded-full bg-isobar-soft px-2.5 py-0.5 text-xs text-isobar">
                {u}
              </li>
            ))}
          </ul>
        </div>
      )}
    </WidgetFrame>
  )
}
