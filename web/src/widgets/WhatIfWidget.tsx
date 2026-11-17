// what_if in the chat: with upgrade costs, review priority per $1M (the analyst's own costs); with weights only,
// the re-ranked review priority. Every number is the tool's own value. The sliders live on the Scores page.
import { fmt, formatDate, hubName } from '@/lib/format'
import type { WhatIfResult } from '@/lib/types'
import { BandPill, WidgetFrame } from './WidgetFrame'

const cell = 'h-10 border-b border-border/50 px-2 align-middle'
const top = 'rounded-md bg-isobar-soft px-1.5 py-0.5 font-medium text-foreground'

export function WhatIfWidget({ data }: { data: WhatIfResult }) {
  const perMillion = data.per_million_ranking ?? []
  const weights = data.inputs_echo?.family_weights
  const weighted = Boolean(weights && Object.values(weights).some((w) => w != null))
  const note = `${perMillion.length ? 'Upgrade costs are your inputs, not data from our sources. ' : ''}${
    weighted ? 'Hazard weights are your inputs. ' : ''
  }A screening measure, not a return on investment. Data as of ${formatDate(data.data_as_of)}. Adjust weights and costs with What-if on the Scores tab.`

  if (perMillion.length)
    return (
      <WidgetFrame label="What-if: review priority per $1M" title="Review priority per $1M (your costs)" note={note}>
        <div className="-mx-1 overflow-x-auto px-1">
          <table className="w-full border-separate border-spacing-0 text-sm tabular-nums" aria-label="Review priority per million dollars">
            <thead>
              <tr className="text-xs text-muted-foreground">
                <th scope="col" className={`${cell} w-8 text-left font-semibold`}>#</th>
                <th scope="col" className={`${cell} text-left font-semibold`}>Hub</th>
                <th scope="col" className={`${cell} text-right font-semibold`}>Review priority</th>
                <th scope="col" className={`${cell} text-right font-semibold`}>Cost, $M</th>
                <th scope="col" className={`${cell} text-right font-semibold`}>Priority per $1M</th>
              </tr>
            </thead>
            <tbody>
              {perMillion.map((h, i) => (
                <tr key={h.hub_id} data-hub={h.hub_id}>
                  <td className={`${cell} text-muted-foreground`}>{h.rank}</td>
                  <th scope="row" className={`${cell} text-left font-semibold`}>{hubName(h.hub_id)}</th>
                  <td className={`${cell} text-right`}>{fmt(h.priority)}</td>
                  <td className={`${cell} text-right`}>{fmt(h.cost_musd)}</td>
                  <td className={`${cell} text-right`}>
                    <span data-top={i === 0 || undefined} className={i === 0 ? top : 'px-1.5'}>
                      {fmt(h.priority_per_million)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WidgetFrame>
    )

  return (
    <WidgetFrame label="What-if: re-ranked review priority" title="Review priority with your weights" note={note}>
      <ol className="space-y-1 text-sm tabular-nums" aria-label="Re-ranked review priority">
        {data.ranking.slice(0, 10).map((h) => (
          <li key={h.hub_id} data-hub={h.hub_id} className="flex items-center gap-2">
            <span className="w-5 text-muted-foreground">{h.rank}</span>
            <span className="flex-1 font-medium">{hubName(h.hub_id)}</span>
            {h.band && <BandPill band={h.band} />}
            <span className="w-12 text-right">{fmt(h.value)}</span>
          </li>
        ))}
      </ol>
    </WidgetFrame>
  )
}
