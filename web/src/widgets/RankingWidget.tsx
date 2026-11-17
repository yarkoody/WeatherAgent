import { Bar, BarChart, Cell, LabelList, ReferenceLine, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { HazardIcon } from '@/components/HazardIcon'
import { BAND_COLOR, BAND_LABEL, BAND_LABEL_COLOR, HAZARD_LABEL, fmt, formatDate, shortHubName } from '@/lib/format'
import type { Band, Ranking } from '@/lib/types'

/** Bars without a band (bad-year ranking): neutral ink, so color never implies a band. */
const NEUTRAL = 'var(--color-ink-soft)' // theme token: readable in light and dark
import { InfoTip } from '@/components/InfoTip'
import { indexSteps } from '@/lib/explain'
import { useReducedMotion } from '@/lib/motion'
import { WidgetFrame } from './WidgetFrame'

export function rankingTitle(r: Ranking): string {
  if (r.kind === 'bad_year') return r.region ? `Bad-year disruption days (1 in 20) in the ${r.region}` : 'Bad-year disruption days (1 in 20)'
  const kind = r.kind === 'priority' ? 'screening priority' : 'exposure'
  const what = r.hazard === 'overall' ? kind[0].toUpperCase() + kind.slice(1) : `${HAZARD_LABEL[r.hazard]} ${kind}`
  return r.region ? `${what} in the ${r.region}` : `${what} across all hubs`
}

const config = { value: { label: 'Score' } } satisfies ChartConfig

/** Built from the ranking's own thresholds; per-signal detail needs one hub (ask about it). */
function rankingLines(r: Ranking): string[] {
  const t = r.band_thresholds
  if (r.kind === 'bad_year')
    return [
      'In a bad year (about 1 year in 20) a hub can lose far more days than average, because rare events like hurricanes are much worse.',
      'These bars show those modeled bad-year lost days (estimates).',
      'Ask about one hub to compare its typical and bad year.',
    ]
  if (r.kind === 'priority')
    return [
      'Screening priority suggests where to look first at upgrades; it is not a cost-benefit estimate.',
      'It mixes the exposure score with people served and the resilience gap.',
      `Medium from ${fmt(t.medium_from)}, high from ${fmt(t.high_from)} (out of 100).`,
    ]
  if (r.hazard === 'overall') return ['The score counts modeled lost days a year from all hazards.', ...indexSteps(t)]
  return [
    `The score counts modeled lost days a year from ${HAZARD_LABEL[r.hazard].toLowerCase()} alone.`,
    `Bar color is its band by lost days a year, not by the score: medium from ${fmt(t.family_medium_from_days)} days, high from ${fmt(t.family_high_from_days)}.`,
  ]
}

export function RankingWidget({ data }: { data: Ranking }) {
  const reduced = useReducedMotion()
  // Hazard rankings: bar length is the 0-100 score, but color is the hazard's band by lost days a year, so a short
  // bar can be High. Each bar's label names its band ("30.7 · High") and the subtitle says so in plain words.
  const hazardBands = data.kind !== 'bad_year' && data.hazard !== 'overall'
  const rows = data.items.map((i) => ({
    ...i,
    label: shortHubName(i.name),
    text: hazardBands && i.band ? `${fmt(i.value)} · ${BAND_LABEL[i.band]}` : fmt(i.value),
  }))
  const { medium_from, high_from } = data.band_thresholds
  const days = data.kind === 'bad_year' // values are days, not the 0-100 index
  // The 35/60 lines belong to the overall 0-100 index (and priority). A hazard ranking is banded by that hazard's
  // lost days (medium from 2, high from 5), so the lines would contradict the bar colors there.
  const indexLines = !days && data.hazard === 'overall'
  const height = rows.length * 30 + 34

  return (
    <WidgetFrame
      label="Ranking chart"
      title={
        <span className="flex items-center gap-1.5">
          {data.hazard !== 'overall' && data.kind !== 'bad_year' && <HazardIcon hazard={data.hazard} />}
          {rankingTitle(data)}
          <InfoTip subject={`${rankingTitle(data).toLowerCase()} score`} title="How to read this" steps={rankingLines(data)} />
        </span>
      }
      note={
        days
          ? `Average lost days in the worst 1 year in 20. Data as of ${formatDate(data.data_as_of)}.`
          : indexLines
            ? `Score 0 to 100. Medium from ${fmt(medium_from)}, high from ${fmt(high_from)}. Data as of ${formatDate(data.data_as_of)}.`
            : `Bar length is the ${HAZARD_LABEL[data.hazard].toLowerCase()} score (0 to 100). Bar color is the hazard's band by lost days a year: medium from ${fmt(data.band_thresholds.family_medium_from_days)} days, high from ${fmt(data.band_thresholds.family_high_from_days)}, so a short bar can still be High. Data as of ${formatDate(data.data_as_of)}.`
      }
    >
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height }} initialDimension={{ width: 560, height }}>
        <BarChart data={rows} layout="vertical" margin={{ top: 18, right: hazardBands ? 92 : 40, bottom: 0, left: 0 }} barCategoryGap={6} accessibilityLayer>
          <XAxis type="number" domain={days ? [0, Math.ceil(Math.max(...rows.map((r) => r.value), 1))] : [0, 100]} hide />
          <YAxis type="category" dataKey="label" width={104} tickLine={false} axisLine={false} tick={{ fill: 'var(--foreground)', fontSize: 13 }} />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideIndicator
                formatter={(v, _n, item) => {
                  const band = (item.payload as { band: Band | null }).band
                  return band ? `${fmt(Number(v))} (${BAND_LABEL[band]})` : `${fmt(Number(v))} days`
                }}
              />
            }
          />
          {/* The 35/60 index bands do not apply to a ranking in days. */}
          {indexLines && <ReferenceLine x={medium_from} stroke={BAND_COLOR.medium} strokeDasharray="3 3" label={{ value: fmt(medium_from), position: 'top', fill: BAND_LABEL_COLOR.medium, fontSize: 11 }} />}
          {indexLines && <ReferenceLine x={high_from} stroke={BAND_COLOR.high} strokeDasharray="3 3" label={{ value: fmt(high_from), position: 'top', fill: BAND_LABEL_COLOR.high, fontSize: 11 }} />}
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={!reduced} animationDuration={400} background={{ fill: 'var(--muted)', radius: 4 }}>
            {rows.map((r) => (
              <Cell key={r.hub_id} fill={r.band ? BAND_COLOR[r.band] : NEUTRAL} />
            ))}
            <LabelList dataKey="text" position="right" fill="var(--foreground)" fontSize={12} fontWeight={600} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </WidgetFrame>
  )
}
