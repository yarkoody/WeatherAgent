// "How the scores work": a plain-language primer at the top of the Scores page. Open by default the first time;
// the open/closed choice is remembered in this browser. The example line is built from the live scores.
import { ChevronDownIcon } from 'lucide-react'
import { useState } from 'react'
import { LOST_DAYS } from '@/lib/explain'
import { FAMILY_LABEL, fmt, shortHubName } from '@/lib/format'
import type { ScoreRow } from '@/lib/types'

export const HOWTO_KEY = 'weather-risk.scores-howto'

function readOpen(): boolean {
  try {
    return localStorage.getItem(HOWTO_KEY) !== 'closed'
  } catch {
    return true
  }
}

/** "Why is Minneapolis #1?": the hub with the most typical-year lost days and its top driver, from /scores. */
export function topHubLine(rows: ScoreRow[]): { question: string; answer: string } | null {
  const top = [...rows].sort((a, b) => b.exposure_days_per_year - a.exposure_days_per_year || a.hub_id.localeCompare(b.hub_id))[0]
  if (!top) return null
  const name = shortHubName(top.name)
  return {
    question: `Why is ${name} #1 for lost operating days?`,
    answer: `It has the most in a typical year, about ${fmt(top.exposure_days_per_year)}, and most of them come from ${FAMILY_LABEL[top.top_driver].toLowerCase()}.`,
  }
}

export function HowScoresWork({ rows }: { rows: ScoreRow[] | null }) {
  const [open, setOpen] = useState(readOpen)
  const example = rows ? topHubLine(rows) : null
  const toggle = () =>
    setOpen((o) => {
      try {
        localStorage.setItem(HOWTO_KEY, o ? 'closed' : 'open')
      } catch {
        /* per-browser convenience only */
      }
      return !o
    })

  return (
    <section aria-labelledby="howto-title" className="mt-4 rounded-3xl bg-foreground/[0.03] ring-1 ring-border/60">
      <h2 id="howto-title" className="m-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="howto-body"
          onClick={toggle}
          className="flex w-full items-center justify-between gap-3 rounded-3xl px-5 py-3 text-left text-sm font-semibold focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
        >
          How the scores work
          <ChevronDownIcon className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </h2>
      {open && (
        <div id="howto-body" className="max-w-[72ch] space-y-1.5 px-5 pb-4 text-sm leading-relaxed text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Lost operating days</span> are {LOST_DAYS} The hazards are heavy snow or deep cold, flooding,
            hurricanes and severe storms.
          </p>
          <p>
            <span className="font-medium text-foreground">Typical year</span> is the model's average. <span className="font-medium text-foreground">Bad year</span>{' '}
            is the average of the worst 1 year in 20, when rare events such as hurricanes hit.
          </p>
          <p>Each hazard blends how often FEMA expects such events in the county with how often the weather at the hub really crossed a disruption threshold.</p>
          <p>
            <span className="font-medium text-foreground">Exposure score</span> puts lost operating days on a 0 to 100 scale.{' '}
            <span className="font-medium text-foreground">Screening priority</span> weighs exposure up for hubs that serve more people or sit in less
            resilient counties: where to look first, not what an upgrade is worth.
          </p>
          <p>That is why a hub can be High exposure but Medium priority.</p>
          {/* Reserve the line while scores load, so nothing below moves. */}
          <p data-testid="howto-example" className="min-h-[1.625em]">
            {example && (
              <>
                <span className="font-medium text-foreground">{example.question}</span> {example.answer}
              </>
            )}
          </p>
        </div>
      )}
    </section>
  )
}
