import { Cell, Pie, PieChart } from 'recharts'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { METRIC_LABEL, fmt, hubName } from '@/lib/format'
import type { WeatherStat } from '@/lib/types'
import { WidgetFrame } from './WidgetFrame'

const RING_COLOR: Record<string, string> = {
  snow_days_pct: '#7FA6CC',
  freezing_days_pct: '#5B87B0',
  heavy_rain_days: '#2F5D8A',
  high_wind_days: '#7C8A94',
}

export function WeatherStatRing({ data }: { data: WeatherStat }) {
  const name = hubName(data.hub_id)
  const metric = METRIC_LABEL[data.metric] ?? data.metric
  const isTotal = data.metric.startsWith('total_')
  const ring = !isTotal && data.denominator > 0 && data.numerator >= 0 && data.numerator <= data.denominator
  const color = RING_COLOR[data.metric] ?? '#2F5D8A'
  const headline = data.unit === '%' ? `${fmt(data.value)}%` : fmt(data.value)

  return (
    <WidgetFrame label={`${name} ${metric} ${data.year}`} title={`${name} ${metric} in ${data.year}`}>
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
                isAnimationActive={false}
              >
                <Cell fill={color} />
                <Cell fill="var(--muted)" />
              </Pie>
            </PieChart>
            </ChartContainer>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="font-wide text-xl font-semibold">{headline}</span>
              {data.unit !== '%' && <span className="text-[0.65rem] text-muted-foreground">{data.unit}</span>}
            </div>
          </div>
        ) : (
          <p className="font-wide text-3xl font-semibold">
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
            {data.source}. Data as of {data.data_as_of}.
          </p>
        </div>
      </div>
    </WidgetFrame>
  )
}
