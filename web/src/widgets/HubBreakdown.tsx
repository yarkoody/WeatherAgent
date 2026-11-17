import { Bar, BarChart, ReferenceLine, XAxis, YAxis } from 'recharts'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { ReadingGuide } from '@/components/ReadingGuide'
import { PEOPLE_DAYS_LINE, bandGapLine, hubDetail, readingGuide } from '@/lib/explain'
import { METHODOLOGY_URL, mathSections } from '@/lib/math'
import { HazardIcon } from '@/components/HazardIcon'
import { ExportReportButton } from '@/components/PrintReport'
import { HubReport } from '@/components/reports'
import { useAsk } from '@/lib/ask'
import { useEffect, useMemo, useState } from 'react'
import { HistoryCharts } from './HistoryWidget'
import { BAND_COLOR, BAND_LABEL_COLOR, FAMILIES, FAMILY_COLOR, FAMILY_LABEL, fmt, formatDate, hubName, isNum, pct, compact, hasPeople } from '@/lib/format'
import { normalizeHub } from '@/lib/normalize'
import { useCountUp, useReducedMotion } from '@/lib/motion'
import type { HubHistory, HubScore } from '@/lib/types'
import { apiFetch } from '@/lib/mockFetch'
import { Skeleton } from '@/components/ui/skeleton'
import { BandText, WidgetFrame } from './WidgetFrame'

const config = {
  ...Object.fromEntries(FAMILIES.map((f) => [f, { label: FAMILY_LABEL[f], color: FAMILY_COLOR[f] }])),
  tail: { label: 'Extra in a bad year', color: '#7b8a95' },
} satisfies ChartConfig

function CountUp({ value }: { value: number }) {
  return <>{fmt(useCountUp(value))}</>
}

/** Typical year and bad year side by side (the widget's "How to read this" explains both). Saved pre-v2 data has no bad year. */
export function Lenses({ data: raw }: { data: HubScore }) {
  const data = useMemo(() => normalizeHub(raw), [raw])
  // Same label row, same number size, same unit position: the two headline numbers always sit on one line.
  const number = 'heading-tight text-3xl leading-none font-semibold tracking-tight tabular-nums'
  const unit = 'ml-1 text-xs font-normal tracking-normal text-muted-foreground'
  return (
    <dl className="grid w-fit grid-cols-[repeat(2,auto)] gap-x-8" aria-label="Lost operating days">
      <div role="group" aria-label="Typical year">
        <dt className="text-xs text-muted-foreground">Typical year</dt>
        <dd className={`mt-1.5 ${number}`}>
          <span>
            <CountUp value={data.exposure_days_per_year} />
          </span>
          <span className={unit}>days/yr</span>
        </dd>
      </div>
      {typeof data.bad_year_days === 'number' && (
        <div role="group" aria-label="Bad year">
          <dt className="text-xs text-muted-foreground">Bad year</dt>
          <dd className={`mt-1.5 ${number}`}>
            <span>
              <CountUp value={data.bad_year_days} />
            </span>
            <span className={unit}>days/yr</span>
          </dd>
        </div>
      )}
    </dl>
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
    <WidgetFrame
      label={`${name} risk breakdown`}
      title={
        <span className="flex items-center gap-1">
          {name} risk breakdown
          <ReadingGuide legend={readingGuide(t)} detail={hubDetail(data)} />
        </span>
      }
      note={`Data as of ${formatDate(data.data_as_of)}.`}
    >
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
      <div role="tabpanel" id={`${data.hub_id}-panel-overview`} aria-labelledby={`${data.hub_id}-tab-overview`} className="@container">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <Lenses data={data} />
        <dl className="flex gap-6 text-sm">
          <div>
            <dt className="text-xs text-muted-foreground">Exposure score</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">
              {fmt(data.exposure)}
              {data.exposure_band && <span aria-hidden="true" className="font-normal text-muted-foreground">{' · '}</span>}
              <BandText band={data.exposure_band} />
            </dd>
          </div>
          <div>
            <dt className="text-xs text-muted-foreground">Review priority (typical year)</dt>
            <dd className="mt-0.5 font-semibold tabular-nums">
              {fmt(data.priority)}
              {data.priority_band && <span aria-hidden="true" className="font-normal text-muted-foreground">{' · '}</span>}
              <BandText band={data.priority_band} />
            </dd>
            {/* The bad year beside it, so a hub with a low typical priority never reads as safe. */}
            {isNum(data.bad_year_days) && (
              <dd data-testid="priority-bad-year" className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                Bad year: {fmt(data.bad_year_days)} lost days
              </dd>
            )}
          </div>
        </dl>
      </div>
      {bandGapLine(data) && <p className="mt-2 text-xs text-muted-foreground">{bandGapLine(data)}</p>}
      {hasPeople(data) && <PeopleImpactRows data={data} />}

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
        {cutoffs && ` Dashed lines: medium level from ${fmt(mediumDays, 2)} days, high from ${fmt(highDays, 2)} days a year.`}
      </p>

      <ul className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 text-sm @lg:grid-cols-4">
        {FAMILIES.map((f) => {
          const fam = data.families[f]
          if (!fam) return null
          const top = f === data.top_driver
          const isHurricane = f === 'hurricane' && hasHurricanePct
          return (
            <li key={f} aria-label={fam.band ? `${FAMILY_LABEL[f]}: ${fam.band} level` : FAMILY_LABEL[f]} data-band={fam.band} className="flex items-start gap-2">
              <HazardIcon hazard={f} className="mt-0.5 size-4" />
              <span className="min-w-0">
                <span className={`block ${top ? 'font-semibold' : ''}`}>{FAMILY_LABEL[f]}</span>
                <span className="block text-xs text-muted-foreground">
                  {isHurricane ? `${pct(data.hurricane_10yr_probability_pct)} chance in 10 years` : `${fmt(fam.days_per_year)} days/yr`}
                  {typeof fam.bad_year_days === 'number' && `, ${fmt(fam.bad_year_days)} days in a bad year`}
                  {fam.band && (
                    <>
                      {', '}
                      <BandText band={fam.band} />
                    </>
                  )}
                </span>
                {top && <span className="text-xs font-semibold text-isobar">Biggest risk</span>}
              </span>
            </li>
          )
        })}
      </ul>

      <SeeTheMath data={data} />

      {data.upgrade_categories.length > 0 && (
        <p className="mt-4 border-t border-border/60 pt-3 text-sm text-muted-foreground">
          Upgrade types to consider{data.top_driver ? ` for ${FAMILY_LABEL[data.top_driver].toLowerCase()}` : ''}:{' '}
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

/** History tab: the history the agent already fetched in this chat, otherwise GET /hubs/{hub_id}/history. */
function HistoryTab({ hubId, name }: { hubId: string; name: string }) {
  const { histories } = useAsk()
  const known = histories[hubId]
  const [state, setState] = useState<{ data?: HubHistory; error?: string } | null>(null)
  useEffect(() => {
    if (known) return
    const ctl = new AbortController()
    setState(null)
    apiFetch(`/hubs/${encodeURIComponent(hubId)}/history`, { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(((await r.json().catch(() => null)) as { detail?: string } | null)?.detail ?? `HTTP ${r.status}`)
        return r.json() as Promise<HubHistory>
      })
      .then((data) => setState({ data }))
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setState({ error: e.message })
      })
    return () => ctl.abort()
  }, [hubId, known])
  const data = known ?? state?.data
  if (data) return <HistoryCharts data={data} />
  if (state?.error)
    return (
      <p className="rounded-2xl bg-band-high-soft px-4 py-3 text-sm text-band-high-text" role="alert">
        The observed history for {name} could not be loaded ({state.error}).
      </p>
    )
  return (
    <div role="status" aria-label={`Loading the observed history for ${name}`} className="space-y-2 py-2">
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="h-20 w-full rounded-2xl" />
    </div>
  )
}

/** People impact: people served (metro estimate) and people-days, typical and bad year, with one plain line. */
function PeopleImpactRows({ data }: { data: HubScore }) {
  return (
    <section aria-label="People impact" className="mt-3 border-t border-border/60 pt-3">
      <dl className="grid grid-cols-3 gap-x-4 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">People served (metro)</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{compact(data.people_served)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">People-days, typical (M/yr)</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{fmt(data.people_days_m)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">People-days, bad year (M/yr)</dt>
          <dd className="mt-0.5 font-semibold tabular-nums">{fmt(data.people_days_bad_year_m)}</dd>
        </div>
      </dl>
      <p className="mt-1.5 text-xs text-muted-foreground">
        {PEOPLE_DAYS_LINE} People served is the metro-area population{data.metro_name ? ` (${data.metro_name})` : ''}, an estimate, not the hub&apos;s customers.
      </p>
    </section>
  )
}

/** "See the math": closed by default; the hub's own calculation, every number from the tool output. */
function SeeTheMath({ data }: { data: HubScore }) {
  const sections = mathSections(data)
  return (
    <details data-testid="see-the-math" className="group/math mt-4 rounded-2xl bg-foreground/[0.03] px-3 py-2">
      <summary className="cursor-pointer text-sm font-medium">See the math</summary>
      <div className="mt-2 space-y-3">
        {sections.map((sec) => (
          <section key={sec.title} aria-label={sec.title}>
            <h4 className="text-xs font-semibold text-foreground">{sec.title}</h4>
            <ul className="mt-1 space-y-0.5 font-mono text-[0.7rem] leading-relaxed text-muted-foreground tabular-nums">
              {sec.lines.map((l) => (
                <li key={l} className="break-words">
                  {l}
                </li>
              ))}
            </ul>
          </section>
        ))}
        <a href={METHODOLOGY_URL} target="_blank" rel="noreferrer" className="inline-block text-xs font-medium text-isobar underline-offset-2 hover:underline">
          Full methodology
        </a>
      </div>
    </details>
  )
}
