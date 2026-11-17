import { Bar, BarChart, Cell, LabelList, ReferenceLine, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { BAND_COLOR, BAND_LABEL, BAND_LABEL_COLOR, HAZARD_LABEL, fmt, shortHubName } from '@/lib/format'
import type { Ranking } from '@/lib/types'
import { InfoTip } from '@/components/InfoTip'
import { indexLine } from '@/lib/explain'
import { WidgetFrame } from './WidgetFrame'

export function rankingTitle(r: Ranking): string {
  const kind = r.kind === 'priority' ? 'investment priority' : 'exposure'
  const what = r.hazard === 'overall' ? kind[0].toUpperCase() + kind.slice(1) : `${HAZARD_LABEL[r.hazard]} ${kind}`
  return r.region ? `${what} in the ${r.region}` : `${what} across all hubs`
}

const config = { value: { label: 'Score' } } satisfies ChartConfig

/** Built from the ranking's own thresholds; per-signal detail needs one hub (ask about it). */
function rankingLines(r: Ranking): string[] {
  const t = r.band_thresholds
  const bands = `Bands: medium from ${t.medium_from}, high from ${t.high_from}.`
  if (r.kind === 'priority')
    return ['Priority is a weighted blend of overall exposure, people served and the resilience gap, each on 0 to 100.', bands, 'Ask about one hub to see its signals and weights.']
  return [
    r.hazard === 'overall' ? 'Exposure adds up the expected disruption days a year from all four hazard families.' : `The ${HAZARD_LABEL[r.hazard].toLowerCase()} score counts that family's expected disruption days a year.`,
    indexLine(t),
    'Ask about one hub to see its signals and weights.',
  ]
}

export function RankingWidget({ data }: { data: Ranking }) {
  const rows = data.items.map((i) => ({ ...i, label: shortHubName(i.name) }))
  const { medium_from, high_from } = data.band_thresholds
  const height = rows.length * 30 + 34

  return (
    <WidgetFrame
      label="Ranking chart"
      title={
        <span className="flex items-center gap-1">
          {rankingTitle(data)}
          <InfoTip subject={`${rankingTitle(data).toLowerCase()} score`} lines={rankingLines(data)} />
        </span>
      }
      note={`Score 0 to 100. Medium from ${fmt(medium_from)}, high from ${fmt(high_from)}. Data as of ${data.data_as_of}.`}
    >
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height }} initialDimension={{ width: 560, height }}>
        <BarChart data={rows} layout="vertical" margin={{ top: 18, right: 40, bottom: 0, left: 0 }} barCategoryGap={6} accessibilityLayer>
          <XAxis type="number" domain={[0, 100]} hide />
          <YAxis type="category" dataKey="label" width={104} tickLine={false} axisLine={false} tick={{ fill: 'var(--foreground)', fontSize: 13 }} />
          <ChartTooltip
            cursor={false}
            content={<ChartTooltipContent hideIndicator formatter={(v, _n, item) => `${fmt(Number(v))} (${BAND_LABEL[(item.payload as { band: 'low' }).band]})`} />}
          />
          <ReferenceLine x={medium_from} stroke={BAND_COLOR.medium} strokeDasharray="3 3" label={{ value: fmt(medium_from), position: 'top', fill: BAND_LABEL_COLOR.medium, fontSize: 11 }} />
          <ReferenceLine x={high_from} stroke={BAND_COLOR.high} strokeDasharray="3 3" label={{ value: fmt(high_from), position: 'top', fill: BAND_LABEL_COLOR.high, fontSize: 11 }} />
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={false} background={{ fill: 'var(--muted)', radius: 4 }}>
            {rows.map((r) => (
              <Cell key={r.hub_id} fill={BAND_COLOR[r.band]} />
            ))}
            <LabelList dataKey="value" position="right" fill="var(--foreground)" fontSize={12} fontWeight={600} formatter={(v: unknown) => fmt(Number(v))} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </WidgetFrame>
  )
}
