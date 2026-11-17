// Ranking (rank_hubs): one definition per ranking kind (title, unit, value format, whether 0-100 bands apply).
// Bars show the number only; on banded kinds the bar color is the level (explained in the subtitle). A one-hazard
// ranking uses that hazard's own level from the tool (2 / 5 lost days a year; hurricane by its 10-year chance), the
// same level the answer text cites, so chart and text never disagree.
// A ranking with a single hub is a compact stat card, not a one-bar chart.
import { Bar, BarChart, Cell, LabelList, ReferenceLine, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { HazardIcon } from '@/components/HazardIcon'
import { InfoTip } from '@/components/InfoTip'
import { LOST_DAYS, PEOPLE_DAYS_LINE, PEOPLE_SERVED_DEF, REVIEW_PRIORITY_MEANING, indexSteps } from '@/lib/explain'
import { BAND_COLOR, BAND_LABEL, BAND_LABEL_COLOR, HAZARD_LABEL, compact, fmt, formatDate, shortHubName } from '@/lib/format'
import { useReducedMotion } from '@/lib/motion'
import type { Band, Ranking } from '@/lib/types'
import { BandPill, WidgetFrame } from './WidgetFrame'

/** Bars without a band: neutral ink, so color never implies a level. */
const NEUTRAL = 'var(--color-ink-soft)'

type Kind = Ranking['kind']

interface KindSpec {
  /** The 0-100 index with medium/high cut-offs (bands, colored bars, 35/60 lines). */
  banded: boolean
  /** Unit written once (subtitle, stat card, tooltip). */
  unit: string
  format: (v: number) => string
  title: (r: Ranking) => string
}

const inRegion = (r: Ranking) => (r.region ? ` in the ${r.region}` : '')

const SPECS: Record<Kind, KindSpec> = {
  exposure: {
    banded: true,
    unit: 'score, 0-100',
    format: (v) => fmt(v),
    title: (r) => (r.hazard === 'overall' ? `Exposure${r.region ? inRegion(r) : ' across all hubs'}` : `${HAZARD_LABEL[r.hazard]} exposure${r.region ? inRegion(r) : ' across all hubs'}`),
  },
  priority: {
    banded: true,
    unit: 'score, 0-100',
    format: (v) => fmt(v),
    title: (r) => `Review priority${r.region ? inRegion(r) : ' across all hubs'}`,
  },
  bad_year: { banded: false, unit: 'lost operating days in a bad year', format: (v) => fmt(v), title: (r) => `Bad-year lost operating days${inRegion(r)}` },
  people_impact: {
    banded: false,
    unit: 'million people-days a year',
    format: (v) => fmt(v),
    title: (r) => `People-days if disrupted${inRegion(r)} (million a year)`,
  },
  people_served: { banded: false, unit: 'people (metro estimate)', format: (v) => compact(v), title: (r) => `People served${inRegion(r)} (metro estimate)` },
}

/** A kind the UI does not know yet: no bands, plain numbers, a neutral title (never "Exposure"). */
const FALLBACK: KindSpec = { banded: false, unit: '', format: (v) => fmt(v), title: (r) => `Hub ranking${inRegion(r)}` }
export const specOf = (r: Ranking): KindSpec => SPECS[r.kind] ?? FALLBACK

export function rankingTitle(r: Ranking): string {
  return specOf(r).title(r)
}

const config = { value: { label: 'Value' } } satisfies ChartConfig

/** "How to read this" lines, built from the ranking's own thresholds. */
function rankingLines(r: Ranking): string[] {
  const t = r.band_thresholds
  switch (r.kind) {
    case 'bad_year':
      return [
        'In a bad year (about 1 year in 20) a hub can lose far more days than average, because rare events like hurricanes are much worse.',
        `Lost operating days: ${LOST_DAYS}`,
        'Ask about one hub to compare its typical and bad year.',
      ]
    case 'people_impact':
      return [PEOPLE_DAYS_LINE, `People served: ${PEOPLE_SERVED_DEF}`, 'Values are typical-year people-days, in millions. No levels apply.']
    case 'people_served':
      return [`People served: ${PEOPLE_SERVED_DEF}`, 'A proxy for how many people a hub serves. No levels apply.']
    case 'priority':
      return [
        `Review priority: ${REVIEW_PRIORITY_MEANING}`,
        'It mixes the exposure score with people served and the resilience gap.',
        `Medium from ${fmt(t.medium_from)}, high from ${fmt(t.high_from)} (out of 100).`,
      ]
    case 'exposure':
      if (r.hazard === 'overall') return [`Lost operating days: ${LOST_DAYS}`, 'The score counts those days a year from all hazards.', ...indexSteps(t)]
      return [
        `Lost operating days: ${LOST_DAYS}`,
        `The score counts those days a year from ${HAZARD_LABEL[r.hazard].toLowerCase()} alone: days ÷ ${fmt(t.days_cap)} × 100.`,
        `Bar color is the ${HAZARD_LABEL[r.hazard].toLowerCase()} level. ${hazardLevelRule(r)} One hazard needs fewer days to matter than all of them together, so its levels start lower than the overall 35 and 60.`,
      ]
    default:
      return ['Hubs ranked by the value the agent asked for.']
  }
}

/** One hazard's level rule, from the tool's cut-offs: lost days a year, or the 10-year chance for hurricanes. */
function hazardLevelRule(r: Ranking): string {
  const t = r.band_thresholds
  if (r.hazard === 'hurricane')
    return `Its level is set by the chance of at least one hurricane in 10 years (medium from ${fmt(t.hurricane_medium_from_pct)}%, high from ${fmt(t.hurricane_high_from_pct)}%).`
  return `Medium from ${fmt(t.family_medium_from_days)} lost days a year (score ${fmt(dayScore(t.family_medium_from_days, t))}), high from ${fmt(t.family_high_from_days)} (score ${fmt(dayScore(t.family_high_from_days, t))}).`
}

/** Lost days a year as a 0-100 score (days ÷ cap × 100), to draw a day cut-off on the score axis. */
const dayScore = (days: number, t: Ranking['band_thresholds']) => (days / t.days_cap) * 100

/** The 0-100 score's own band, from the tool's cut-offs (the same 35/60 lines drawn on the chart). */
function scoreBand(value: number, t: Ranking['band_thresholds']): Band {
  return value >= t.high_from ? 'high' : value >= t.medium_from ? 'medium' : 'low'
}

/** Bar label: the value only (the level is the bar color, explained in the subtitle). */
function BarLabel(props: { x?: number | string; y?: number | string; width?: number | string; height?: number | string; index?: number; rows: { text: string }[] }) {
  const row = props.rows[props.index ?? 0]
  if (!row) return null
  return (
    <text x={Number(props.x ?? 0) + Number(props.width ?? 0) + 6} y={Number(props.y ?? 0) + Number(props.height ?? 0) / 2} dominantBaseline="central" fontSize={12} fontWeight={600} fill="var(--foreground)">
      {row.text}
    </text>
  )
}

/** "Top 5 of 15 hubs." when the ranking is a subset; "All 15 hubs." / "All 6 Midwest hubs." when it covers every match. */
export function coverage(shown: number, total: number, region: string | null): string {
  return shown < total ? `Top ${shown} of ${total} hubs.` : `All ${total} ${region ? `${region} ` : ''}hubs.`
}

function subtitle(r: Ranking, spec: KindSpec): string {
  const t = r.band_thresholds
  const asOf = `Data as of ${formatDate(r.data_as_of)}.`
  if (r.kind === 'people_impact') return `${PEOPLE_DAYS_LINE} ${asOf}`
  if (r.kind === 'people_served') return `Metro-area population, an estimate used as a proxy, not the hub's customers. ${asOf}`
  if (r.kind === 'bad_year') return `Bad year: the average of the worst 1 year in 20. ${asOf}`
  if (!spec.banded) return asOf
  if (r.kind === 'exposure' && r.hazard !== 'overall')
    return `Bar length: the ${HAZARD_LABEL[r.hazard].toLowerCase()} score, 0 to 100. Color: the ${HAZARD_LABEL[r.hazard].toLowerCase()} level. ${hazardLevelRule(r)} ${asOf}`
  return `Score 0 to 100. Medium from ${fmt(t.medium_from)}, high from ${fmt(t.high_from)}. ${asOf}`
}

export function RankingWidget({ data }: { data: Ranking }) {
  const reduced = useReducedMotion()
  const spec = specOf(data)
  const t = data.band_thresholds
  const hazardBands = data.kind === 'exposure' && data.hazard !== 'overall'
  const rows = data.items.map((i) => ({
    ...i,
    label: shortHubName(i.name),
    text: spec.format(i.value),
    level: spec.banded ? (i.band ?? scoreBand(i.value, t)) : null,
  }))
  // Cut-off lines on the score axis: 35/60 for the index; a hazard's 2/5-day cut-offs as scores; none for hurricane
  // (its level is a 10-year chance, not a position on this axis).
  const cuts = !spec.banded
    ? null
    : !hazardBands
      ? { medium: t.medium_from, high: t.high_from }
      : data.hazard === 'hurricane'
        ? null
        : { medium: dayScore(t.family_medium_from_days, t), high: dayScore(t.family_high_from_days, t) }
  const total = typeof data.total === 'number' && data.total > 0 ? data.total : null
  const title = (
    <span className="flex items-center gap-1.5">
      {data.hazard !== 'overall' && data.kind === 'exposure' && <HazardIcon hazard={data.hazard} />}
      {rankingTitle(data)}
      <InfoTip subject={`${rankingTitle(data).toLowerCase()} score`} title="How to read this" steps={rankingLines(data)} />
    </span>
  )
  const note = (
    <>
      {total !== null && <span className="font-medium text-foreground">{`${coverage(rows.length, total, data.region)} `}</span>}
      {subtitle(data, spec)}
    </>
  )

  // One hub: a compact stat card (hub, value, unit, level), not a one-bar chart.
  if (rows.length === 1) {
    const r = rows[0]
    return (
      <WidgetFrame label="Ranking" title={title} note={note}>
        <div data-testid="ranking-stat" className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-semibold">{r.label}</span>
          <span className="heading-tight text-3xl font-semibold tabular-nums">{r.text}</span>
          <span className="text-xs text-muted-foreground">{spec.unit}</span>
          {r.level && <BandPill band={r.level} />}
        </div>
      </WidgetFrame>
    )
  }

  const height = rows.length * 30 + 34
  const max = Math.max(...rows.map((r) => r.value), 1)
  return (
    <WidgetFrame label="Ranking chart" title={title} note={note}>
      <ChartContainer config={config} className="aspect-auto w-full" style={{ height }} initialDimension={{ width: 560, height }}>
        <BarChart data={rows} layout="vertical" margin={{ top: 18, right: 52, bottom: 0, left: 0 }} barCategoryGap={6} accessibilityLayer>
          <XAxis type="number" domain={spec.banded ? [0, 100] : [0, max]} hide />
          <YAxis type="category" dataKey="label" width={104} tickLine={false} axisLine={false} tick={{ fill: 'var(--foreground)', fontSize: 13 }} />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                hideIndicator
                formatter={(v, _n, item) => {
                  const p = item.payload as { level: Band | null }
                  const value = `${spec.format(Number(v))} ${spec.unit}`
                  return p.level ? `${value} (${BAND_LABEL[p.level]})` : value
                }}
              />
            }
          />
          {/* The level cut-offs on the score axis (see `cuts`). */}
          {cuts && (
            <ReferenceLine x={cuts.medium} stroke={BAND_COLOR.medium} strokeDasharray="3 3" label={{ value: fmt(cuts.medium), position: 'top', fill: BAND_LABEL_COLOR.medium, fontSize: 11 }} />
          )}
          {cuts && (
            <ReferenceLine x={cuts.high} stroke={BAND_COLOR.high} strokeDasharray="3 3" label={{ value: fmt(cuts.high), position: 'top', fill: BAND_LABEL_COLOR.high, fontSize: 11 }} />
          )}
          <Bar dataKey="value" radius={[0, 4, 4, 0]} isAnimationActive={!reduced} animationDuration={400} background={{ fill: 'var(--muted)', radius: 4 }}>
            {rows.map((r) => (
              <Cell key={r.hub_id} fill={r.level ? BAND_COLOR[r.level] : NEUTRAL} />
            ))}
            <LabelList dataKey="text" content={(p) => <BarLabel {...(p as object)} rows={rows} />} />
          </Bar>
        </BarChart>
      </ChartContainer>
    </WidgetFrame>
  )
}
