import { SirenIcon } from 'lucide-react'
import { formatDateTime, hubName } from '@/lib/format'
import type { ActiveAlerts } from '@/lib/types'

function tone(severity: string) {
  const s = severity.toLowerCase()
  if (s === 'extreme' || s === 'severe') return { bar: 'bg-band-high', text: 'text-band-high-text' }
  if (s === 'moderate') return { bar: 'bg-band-medium', text: 'text-band-medium-text' }
  return { bar: 'bg-isobar', text: 'text-isobar' }
}

/** Live NWS alerts. Renders nothing when there are none: the tool chip already says it checked. */
export function AlertBanner({ data }: { data: ActiveAlerts }) {
  if (data.alerts.length === 0) return null
  const n = data.alerts.length
  return (
    <section className="overflow-hidden w-full rounded-xl bg-band-high-soft/60 ring-1 ring-band-high/30" role="status" aria-label="Live weather alerts">
      <div className="flex items-center gap-2 bg-band-high px-5 py-2.5 text-sm font-semibold text-white">
        <SirenIcon className="size-4" />
        {n} active NWS {n === 1 ? 'alert' : 'alerts'} for {hubName(data.hub_id)}
      </div>
      <ul className="divide-y divide-band-high/15">
        {data.alerts.map((a, i) => {
          const t = tone(a.severity)
          return (
            <li key={`${a.event}-${i}`} className="flex gap-3 px-5 py-2.5">
              <span className={`mt-1 w-1 shrink-0 self-stretch rounded ${t.bar}`} aria-hidden="true" />
              <div className="min-w-0 text-sm">
                <p className="font-semibold">
                  {a.event} <span className={`ml-1 text-xs font-medium ${t.text}`}>{a.severity}</span>
                </p>
                <p className="text-muted-foreground">{a.headline}</p>
                {a.expires && <p className="mt-0.5 text-xs text-muted-foreground">Until {formatDateTime(a.expires)}</p>}
              </div>
            </li>
          )
        })}
      </ul>
      <p className="px-5 pb-4 text-[0.7rem] text-muted-foreground">
        Live from the National Weather Service, fetched {formatDateTime(data.fetched_at)}. Alerts do not change the multi-year scores.
      </p>
    </section>
  )
}
