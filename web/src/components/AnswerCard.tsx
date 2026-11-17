import { ChevronRightIcon, TriangleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Skeleton } from '@/components/ui/skeleton'
import { useDebug } from '@/lib/debug'
import type { ChatResponse } from '@/lib/types'
import { FiguresTable } from './FiguresTable'
import { GroundingBadge } from './GroundingBadge'

type Kind = 'answer' | 'out_of_scope' | 'no_data' | 'could_not_answer'

export function answerKind(r: ChatResponse): Kind {
  if (!r.answer.in_scope) return 'out_of_scope'
  // The backend's fallback answer (grounding failed twice, or the model or a service failed).
  if (r.grounding.status === 'failed' && r.answer.figures.length === 0) return 'could_not_answer'
  if (!r.answer.data_available) return 'no_data'
  return 'answer'
}

/** Thin top accent: the state's color without making the card lopsided. */
const ACCENT: Record<Kind, string> = {
  answer: 'bg-isobar',
  out_of_scope: 'bg-ink-faint',
  no_data: 'bg-band-medium',
  could_not_answer: 'bg-band-high',
}

/** Same shell as the widget cards (shadcn Card): radius, ring, shadow and 20 px padding. */
export const CARD_SHELL = 'glass relative w-full overflow-hidden rounded-3xl p-5 text-card-foreground'

export function AnswerCard({ response }: { response: ChatResponse }) {
  const { answer, grounding } = response
  const debug = useDebug()
  const kind = answerKind(response)
  const failed = grounding.status === 'failed'

  return (
    <article className={CARD_SHELL} data-kind={kind} aria-label="Answer">
      <span className={`absolute inset-x-0 top-0 h-1 ${ACCENT[kind]}`} aria-hidden="true" />
      {kind === 'out_of_scope' && (
        <p className="mb-2 text-sm font-semibold text-ink-soft">Outside what this assistant covers</p>
      )}
      {kind === 'no_data' && <p className="mb-2 text-sm font-semibold text-band-medium-text">No data for this question</p>}
      {kind === 'could_not_answer' && <p className="mb-2 text-sm font-semibold text-band-high-text">Could not answer</p>}

      {failed && kind === 'answer' && (
        <div className="mb-3 flex gap-2 rounded-md bg-band-high-soft px-3 py-2 text-sm text-band-high-text" role="alert">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>These numbers could not be matched to the tool results. Check them before you use them.</span>
        </div>
      )}

      <div className="prose-answer max-w-[68ch] text-[0.95rem] text-ink">
        <Markdown
          remarkPlugins={[remarkGfm]}
          disallowedElements={['img']}
          unwrapDisallowed
          components={{ a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" /> }}
        >
          {answer.answer}
        </Markdown>
      </div>

      {kind === 'out_of_scope' && (
        <p className="mt-2 text-sm text-ink-soft">
          Try asking which hubs are most exposed to a hazard, how two hubs compare, or how often it snowed at a hub in a given year.
        </p>
      )}

      {answer.figures.length > 0 && <Figures response={response} open={debug} failed={failed} />}

      {(answer.assumptions.length > 0 || (kind !== 'out_of_scope' && answer.uncertainty)) && (
        <div className="mt-4 space-y-1 border-t border-rule-soft pt-3 text-sm">
          {answer.assumptions.length > 0 && (
            <details>
              <summary className="text-ink-soft hover:text-ink">Assumptions ({answer.assumptions.length})</summary>
              <ul className="mt-1.5 mb-2 list-disc space-y-1 pl-5 text-ink-soft">
                {answer.assumptions.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </details>
          )}
          {kind !== 'out_of_scope' && answer.uncertainty && (
            <details open={kind === 'no_data' || kind === 'could_not_answer'}>
              <summary className="text-ink-soft hover:text-ink">Data limits</summary>
              <p className="mt-1.5 mb-2 max-w-[68ch] text-ink-soft">{answer.uncertainty}</p>
            </details>
          )}
        </div>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {kind !== 'out_of_scope' && <GroundingBadge grounding={grounding} />}
        {debug && failed && grounding.errors.length > 0 && (
          <details className="text-xs text-ink-soft">
            <summary>Why it is unverified</summary>
            <ul className="mt-1 list-disc pl-5">
              {grounding.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </details>
        )}
        {debug && (
          <span className="ml-auto text-[0.7rem] text-muted-foreground" title="Trace id for debugging">
            trace {response.trace_id.slice(0, 8)}
          </span>
        )}
      </footer>
    </article>
  )
}

export function PendingAnswer() {
  return (
    <div className={CARD_SHELL} aria-live="polite">
      <span className="absolute inset-x-0 top-0 h-1 bg-muted" aria-hidden="true" />
      <p className="text-sm text-ink-soft">Validating figures…</p>
      <div className="mt-3 space-y-2" aria-hidden="true">
        <Skeleton className="h-2.5 w-11/12" />
        <Skeleton className="h-2.5 w-8/12" />
      </div>
    </div>
  )
}

/** The cited numbers, folded by default in the analyst view (the answer text comes first). */
function Figures({ response, open, failed }: { response: ChatResponse; open: boolean; failed: boolean }) {
  const [shown, setShown] = useState(open)
  const n = response.answer.figures.length
  return (
    <div className="mt-4">
      <button
        type="button"
        aria-expanded={shown}
        onClick={() => setShown((v) => !v)}
        className="group inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronRightIcon className={`size-4 transition-transform motion-reduce:transition-none ${shown ? 'rotate-90' : ''}`} />
        Figures behind this answer ({n})
      </button>
      {shown && (
        <div className="mt-2 animate-in fade-in duration-200 motion-reduce:animate-none">
          <FiguresTable figures={response.answer.figures} verified={!failed} />
        </div>
      )}
    </div>
  )
}
