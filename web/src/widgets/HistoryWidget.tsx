// Observed history (get_hub_history): disruption days per year by hazard, and a seasonal heatmap by month.
// Everything here is drawn from the tool output; the (i) carries its thresholds and data note.
import { Bar, BarChart, Cell, XAxis, YAxis } from 'recharts'
import { HazardIcon } from '@/components/HazardIcon'
import { InfoTip } from '@/components/InfoTip'
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'
import { FAMILIES, FAMILY_COLOR, FAMILY_LABEL, fmt, formatDate, shortHubName } from '@/lib/format'
import { useReducedMotion } from '@/lib/motion'
import type { Family, HubHistory } from '@/lib/types'
import { WidgetFrame } from './WidgetFrame'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const config = Object.fromEntries(FAMILIES.map((f) => [f, { label: FAMILY_LABEL[f], color: FAMILY_COLOR[f] }])) satisfies ChartConfig

/** Families with any observed day: hurricane is never observed in daily point data. */
function observedFamilies(h: HubHistory): Family[] {
  return FAMILIES.filter((f) => h.years.some((y) => (y.days[f] ?? 0) > 0) || h.months.some((m) => (m.days[f] ?? 0) > 0))
}

function historyTip(h: HubHistory): string[] {
  return [
    ...FAMILIES.filter((f) => h.thresholds[f]).map((f) => `${FAMILY_LABEL[f]}: ${h.thresholds[f]}.`),
    h.note,
  ]
}

/** The two charts, without a card: used by the widget and by the breakdown's History tab. */
export function HistoryCharts({ data }: { data: HubHistory }) {
  const reduced = useReducedMotion()
  const families = observedFamilies(data)
  const rows = data.years.map((y) => ({ year: String(y.year), ...y.days, total: y.total }))
  const worst = data.years.find((y) => y.year === data.worst_year)
  const max = Math.max(0.01, ...data.months.flatMap((m) => families.map((f) => m.days[f] ?? 0)))

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-medium">
            Lost days per year, {data.start_year} to {data.end_year}
          </p>
          {worst && <p className="text-xs font-semibold text-band-high-text">{`Worst year: ${worst.year} (${fmt(worst.total)} days)`}</p>}
        </div>
        <ChartContainer config={config} className="mt-2 aspect-auto h-48 w-full" initialDimension={{ width: 560, height: 192 }}>
          <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: -18 }} accessibilityLayer>
            <XAxis dataKey="year" tickLine={false} axisLine={false} interval={0} tick={{ fontSize: 10 }} />
            <YAxis tickLine={false} axisLine={false} width={40} tick={{ fontSize: 10 }} allowDecimals={false} />
            <ChartTooltip cursor={{ fill: 'var(--muted)' }} content={<ChartTooltipContent formatter={(v, n) => `${FAMILY_LABEL[n as Family]}: ${fmt(Number(v))} days`} />} />
            {families.map((f, i) => (
              <Bar key={f} dataKey={f} stackId="days" fill={`var(--color-${f})`} radius={i === families.length - 1 ? [3, 3, 0, 0] : 0} isAnimationActive={!reduced} animationDuration={400}>
                {rows.map((r) => (
                  <Cell key={r.year} fillOpacity={Number(r.year) === data.worst_year ? 1 : 0.55} stroke={Number(r.year) === data.worst_year ? 'var(--color-band-high)' : undefined} />
                ))}
              </Bar>
            ))}
          </BarChart>
        </ChartContainer>
        <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {families.map((f) => (
            <li key={f} className="inline-flex items-center gap-1">
              <HazardIcon hazard={f} className="size-3.5" />
              {FAMILY_LABEL[f]}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <p className="text-sm font-medium">Seasonality: average lost days by month</p>
        <div className="mt-2 overflow-x-auto">
          <table aria-label="Average disruption days by month" className="w-full min-w-[520px] border-separate border-spacing-0.5 text-[0.7rem]">
            <thead>
              <tr>
                <th scope="col" className="w-24 text-left font-normal text-muted-foreground">
                  <span className="sr-only">Hazard</span>
                </th>
                {MONTHS.map((m, i) => {
                  const peak = data.peak_months.includes(i + 1)
                  return (
                    <th key={m} scope="col" data-peak={peak} className={`text-center font-normal ${peak ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                      {m}
                      {peak && <span className="mx-auto mt-0.5 block size-1 rounded-full bg-band-high" aria-label="peak month" />}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {families.map((f) => (
                <tr key={f}>
                  <th scope="row" className="pr-2 text-left font-normal whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      <HazardIcon hazard={f} className="size-3.5" />
                      {FAMILY_LABEL[f]}
                    </span>
                  </th>
                  {data.months.map((m) => {
                    const v = m.days[f] ?? 0
                    return (
                      <td
                        key={m.month}
                        aria-label={`${FAMILY_LABEL[f]}, ${MONTHS[m.month - 1]}: ${fmt(v)} days`}
                        className="h-7 rounded-md text-center tabular-nums"
                        style={{ background: `color-mix(in oklab, ${FAMILY_COLOR[f]} ${Math.round((v / max) * 85)}%, transparent)` }}
                      >
                        <span className={v / max > 0.55 ? 'font-semibold text-white' : 'text-foreground/80'}>{v > 0 ? fmt(v) : ''}</span>
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Peak months: {data.peak_months.map((m) => MONTHS[m - 1]).join(', ') || 'none'}. Data as of {formatDate(data.data_as_of)}.
        </p>
      </div>
    </div>
  )
}

export function HistoryWidget({ data }: { data: HubHistory }) {
  const name = shortHubName(data.name)
  return (
    <WidgetFrame
      label={`${name} observed history`}
      title={
        <span className="flex items-center gap-1">
          {name}: observed lost days
          <InfoTip subject="observed history" steps={historyTip(data)} />
        </span>
      }
      note="Observed at the hub point; this is history, not the scored expectation."
    >
      <HistoryCharts data={data} />
    </WidgetFrame>
  )
}
