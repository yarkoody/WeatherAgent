import { Bar, BarChart, Cell, LabelList, ReferenceLine, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { HazardIcon } from '@/components/HazardIcon'
import { BAND_COLOR, BAND_LABEL, BAND_LABEL_COLOR, HAZARD_LABEL, fmt, formatDate, shortHubName } from '@/lib/format'
import type { Band, Ranking } from '@/lib/types'

/** Bars without a band (bad-year ranking): neutral ink, so color never implies a band. */
const NEUTRAL = 'var(--color-ink-soft)' // theme token: readable in light and dark
import { InfoTip } from '@/components/InfoTip'
import { LOST_DAYS, PEOPLE_DAYS_LINE, PEOPLE_SERVED_DEF, REVIEW_PRIORITY_MEANING, indexSteps } from '@/lib/explain'
import { useReducedMotion } from '@/lib/motion'
import { WidgetFrame } from './WidgetFrame'

export function rankingTitle(r: Ranking): string {
  if (r.kind === 'people_impact')
    return `People affected by disruption${r.region ? ` in the ${r.region}` : ''} (million people-days a year)`
  if (r.kind === 'bad_year') return r.region ? `Bad-year lost operating days in the ${r.region}` : 'Bad-year lost operating days'
  const kind = r.kind === 'priority' ? 'review priority' : 'exposure'
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
      'These bars show those modeled bad-year lost operating days (estimates).',
      `Lost operating days: ${LOST_DAYS}`,
      'Ask about one hub to compare its typical and bad year.',
    ]
  if (r.kind === 'people_impact')
    return [
      PEOPLE_DAYS_LINE,
      `People served: ${PEOPLE_SERVED_DEF}`,
      'Bars are typical-year people-days, in millions.',
    ]
  if (r.kind === 'priority')
    return [
      `Review priority: ${REVIEW_PRIORITY_MEANING}`,
      'It mixes the exposure score with people served and the resilience gap.',
      `Medium from ${fmt(t.medium_from)}, high from ${fmt(t.high_from)} (out of 100).`,
    ]
  if (r.hazard === 'overall') return [`Lost operating days: ${LOST_DAYS}`, 'The score counts those days a year from all hazards.', ...indexSteps(t)]
  return [
    `Lost operating days: ${LOST_DAYS}`,
    `The score counts those days a year from ${HAZARD_LABEL[r.hazard].toLowerCase()} alone.`,
    `Bar color is the score's level (medium from ${fmt(t.medium_from)}, high from ${fmt(t.high_from)}); the word after the value is the hazard's own level by lost operating days a year (medium from ${fmt(t.family_medium_from_days)} days, high from ${fmt(t.family_high_from_days)}).`,
  ]
}

/** The 0-100 score's own band, from the tool's cut-offs (the same 35/60 lines drawn on the chart). */
function scoreBand(value: number, t: Ranking['band_thresholds']): Band {
  return value >= t.high_from ? 'high' : value >= t.medium_from ? 'medium' : 'low'
}

/** Bar label: the value, then (hazard rankings) the hazard's own band by days as a small colored word. */
function BarLabel(props: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; value?: unknown; index?: number; rows: { text: string; dayBand: Band | null }[] }) {
  const x = Number(props.x ?? 0) + Number(props.width ?? 0) + 6
  const y = Number(props.y ?? 0) + Number(props.height ?? 0) / 2
  const row = props.rows[props.index ?? 0]
  if (!row) return null
  return (
    <text x={x} y={y} dominantBaseline="central" fontSize={12} fill="var(--foreground)">
      <tspan fontWeight={600}>{row.text}</tspan>
      {row.dayBand && (
        <tspan dx={6} fontSize={10.5} fontWeight={600} fill={BAND_LABEL_COLOR[row.dayBand]}>
          {BAND_LABEL[row.dayBand]} by days
        </tspan>
      )}
    </text>
  )
}

/** "Top 5 of 15 hubs." when the ranking is a subset; "All 15 hubs." / "All 6 Midwest hubs." when it covers every match. */
export function coverage(shown: number, total: number, region: string | null): string {
  return shown < total ? `Top ${shown} of ${total} hubs.` : `All ${total} ${region ? `${region} ` : ''}hubs.`
}

export function RankingWidget({ data }: { data: Ranking }) {
  const reduced = useReducedMotion()
  const t = data.band_thresholds
  // Values not on the 0-100 index: bad-year days, or million people-days. Neutral bars, no 35/60 lines.
  const days = data.kind === 'bad_year' || data.kind === 'people_impact'
  const peopleKind = data.kind === 'people_impact'
  // Hazard rankings: bar length and color are the hazard's 0-100 score and its band (the same 35/60 cut-offs as every
  // score); the hazard's own band by lost days a year is the small word after the value ("High by days").
  const hazardBands = !days && data.hazard !== 'overall'
  const rows = data.items.map((i) => ({
    ...i,
    label: shortHubName(i.name),
    text: fmt(i.value),
    color: days ? NEUTRAL : BAND_COLOR[hazardBands ? scoreBand(i.value, t) : (i.band ?? scoreBand(i.value, t))],
    dayBand: hazardBands ? i.band : null,
  }))
  const { medium_from, high_from } = t
  const indexLines = !days
  const height = rows.length * 30 + 34
  const total = typeof data.total === 'number' && data.total > 0 ? data.total : null
  const asOf = `Data as of ${formatDate(data.data_as_of)}.`

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
        <>
          {total !== null && <span className="font-medium text-foreground">{`${coverage(rows.length, total, data.region)} `}</span>}
          {peopleKind
            ? `${PEOPLE_DAYS_LINE} ${asOf}`
            : days
            ? `Bad year: the average of the worst 1 year in 20. ${asOf}`
            : hazardBands
              ? `Bar length and color: the ${HAZARD_LABEL[data.hazard].toLowerCase()} score, 0 to 100 (medium from ${fmt(medium_from)}, high from ${fmt(high_from)}). The word after each value is the hazard's own level by lost operating days a year (medium from ${fmt(t.family_medium_from_days)} days, high from ${fmt(t.family_high_from_days)}). ${asOf}`
              : `Score 0 to 100. Medium from ${fmt(medium_from)}, high from ${fmt(high_from)}. ${asOf}`}
        </>
      }
    >
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height }} initialDimension={{ width: 560, height }}>
        <BarChart data={rows} layout="vertical" margin={{ top: 18, right: hazardBands ? 112 : 44, bottom: 0, left: 0 }} barCategoryGap={6} accessibilityLayer>
          <XAxis type="number" domain={days ? [0, Math.ceil(Math.max(...rows.map((r) => r.value), 1))] : [0, 100]} hide />
          <YAxis type="category" dataKey="label" width={104} tickLine={false} axisLine={false} tick={{ fill: 'var(--foreground)', fontSize: 13 }} />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideIndicator
                formatter={(v, _n, item) => {
                  if (peopleKind) return `${fmt(Number(v))} million people-days a year`
                  if (days) return `${fmt(Number(v))} days`
                  const p = item.payload as { dayBand: Band | null }
                  const score = `${fmt(Number(v))} (${BAND_LABEL[scoreBand(Number(v), t)]} score)`
                  return p.dayBand ? `${score}, ${BAND_LABEL[p.dayBand]} by days` : score
                }}
              />
            }
          />
          {/* The 35/60 index bands do not apply to a ranking in days. */}
          {indexLines && <ReferenceLine x={medium_from} stroke={BAND_COLOR.medium} strokeDasharray="3 3" label={{ value: fmt(medium_from), position: 'top', fill: BAND_LABEL_COLOR.medium, fontSize: 11 }} />}
          {indexLines && <ReferenceLine x={high_from} stroke={BAND_COLOR.high} strokeDasharray="3 3" label={{ value: fmt(high_from), position: 'top', fill: BAND_LABEL_COLOR.high, fontSize: 11 }} />}
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={!reduced} animationDuration={400} background={{ fill: 'var(--muted)', radius: 4 }}>
            {rows.map((r) => (
              <Cell key={r.hub_id} fill={r.color} />
            ))}
            <LabelList dataKey="text" content={(p) => <BarLabel {...(p as object)} rows={rows} />} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </WidgetFrame>
  )
}
