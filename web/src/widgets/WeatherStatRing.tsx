import { Cell, Pie, PieChart } from 'recharts'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { METRIC_LABEL, fmt, formatDate, hubName } from '@/lib/format'
import type { WeatherStat } from '@/lib/types'
import { InfoTip } from '@/components/InfoTip'
import { weatherStatDetail, weatherStatSteps } from '@/lib/explain'
import { useCountUp, useReducedMotion } from '@/lib/motion'
import { WidgetFrame } from './WidgetFrame'

const RING_COLOR: Record<string, string> = {
  snow_days_pct: 'var(--color-hazard-winter)',
  freezing_days_pct: 'var(--color-hazard-winter)',
  heavy_rain_days: 'var(--color-hazard-flood)',
  high_wind_days: 'var(--color-hazard-severe_storm)',
}

export function WeatherStatRing({ data }: { data: WeatherStat }) {
  const name = hubName(data.hub_id)
  const metric = METRIC_LABEL[data.metric] ?? data.metric
  const isTotal = data.metric.startsWith('total_')
  const ring = !isTotal && data.denominator > 0 && data.numerator >= 0 && data.numerator <= data.denominator
  const color = RING_COLOR[data.metric] ?? 'var(--color-hazard-flood)'
  const reduced = useReducedMotion()
  const shown = useCountUp(data.value)
  // The tool's own precision (one decimal): 10.1% stays 10.1%, never rounded to 10%.
  const headline = data.unit === '%' ? `${fmt(shown, 1)}%` : fmt(shown, 1)

  return (
    <WidgetFrame
      label={`${name} ${metric} ${data.year}`}
      title={
        <span className="flex items-center gap-1">
          {name} {metric} in {data.year}
          <InfoTip
            subject={metric}
            steps={weatherStatSteps(data)}
            detail={weatherStatDetail(data)}
          />
        </span>
      }
    >
      <div className="flex flex-wrap items-center gap-5">
        {ring ? (
          <div className="relative h-[124px] w-[124px] shrink-0">
            <ChartContainer config={{ v: { label: 'Days' } } satisfies ChartConfig} className="aspect-square size-[124px]" initialDimension={{ width: 124, height: 124 }}>
            <PieChart>
              <Pie
                data={[{ v: data.numerator }, { v: data.denominator - data.numerator }]}
                dataKey="v"
                innerRadius={44}
                outerRadius={58}
                startAngle={90}
                endAngle={-270}
                stroke="none"
                isAnimationActive={!reduced}
                animationDuration={400}
              >
                <Cell fill={color} />
                <Cell fill="var(--muted)" />
              </Pie>
            </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="heading-tight text-xl font-semibold">{headline}</span>
              {data.unit !== '%' && <span className="text-[0.65rem] text-muted-foreground">{data.unit}</span>}
            </div>
          </div>
        ) : (
          <p className="heading-tight text-3xl font-semibold">
            {fmt(data.value)} <span className="text-base font-normal text-muted-foreground">{data.unit}</span>
          </p>
        )}
        <div className="min-w-0 flex-1 basis-56 text-sm">
          {ring && (
            <p className="text-base">
              <span className="font-semibold">{fmt(data.numerator)}</span> of {fmt(data.denominator)} days
            </p>
          )}
          <p className="mt-1 text-muted-foreground">{data.definition}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            {data.source}. Data as of {formatDate(data.data_as_of)}.
          </p>
        </div>
      </div>
    </WidgetFrame>
  )
}
