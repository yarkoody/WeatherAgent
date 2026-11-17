import { TriangleAlertIcon } from 'lucide-react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Skeleton } from '@/components/ui/skeleton'
import type { ChatResponse } from '@/lib/types'
import { FiguresTable } from './FiguresTable'
import { GroundingBadge } from './GroundingBadge'

type Kind = 'answer' | 'out_of_scope' | 'no_data'

export function answerKind(r: ChatResponse): Kind {
  if (!r.answer.in_scope) return 'out_of_scope'
  if (!r.answer.data_available) return 'no_data'
  return 'answer'
}

const RULE: Record<Kind, string> = {
  answer: 'border-l-isobar',
  out_of_scope: 'border-l-ink-faint',
  no_data: 'border-l-band-medium',
}

export function AnswerCard({ response }: { response: ChatResponse }) {
  const { answer, grounding } = response
  const kind = answerKind(response)
  const failed = grounding.status === 'failed'

  return (
    <article
      className={`rounded-r-lg border-l-[3px] bg-sheet px-5 py-4 shadow-[0_1px_0_var(--color-rule)] ${RULE[kind]}`}
      data-kind={kind}
      aria-label="Answer"
    >
      {kind === 'out_of_scope' && (
        <p className="mb-2 text-sm font-semibold text-ink-soft">Outside what this assistant covers</p>
      )}
      {kind === 'no_data' && <p className="mb-2 text-sm font-semibold text-[#8a6316]">No data for this question</p>}

      {failed && kind === 'answer' && (
        <div className="mb-3 flex gap-2 rounded-md bg-band-high-soft px-3 py-2 text-sm text-[#7d2622]" role="alert">
          <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>These numbers could not be matched to the tool results. Check them before you use them.</span>
        </div>
      )}

      <div className="prose-answer max-w-[68ch] text-[0.95rem] text-ink">
        <Markdown remarkPlugins={[remarkGfm]}>{answer.answer}</Markdown>
      </div>

      {kind === 'out_of_scope' && (
        <p className="mt-2 text-sm text-ink-soft">
          Try asking which hubs are most exposed to a hazard, how two hubs compare, or how often it snowed at a hub in a given year.
        </p>
      )}

      {answer.figures.length > 0 && (
        <div className="mt-4">
          <FiguresTable figures={answer.figures} />
        </div>
      )}

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
            <details open={kind === 'no_data'}>
              <summary className="text-ink-soft hover:text-ink">Data limits</summary>
              <p className="mt-1.5 mb-2 max-w-[68ch] text-ink-soft">{answer.uncertainty}</p>
            </details>
          )}
        </div>
      )}

      <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        {kind !== 'out_of_scope' && <GroundingBadge grounding={grounding} />}
        {failed && grounding.errors.length > 0 && (
          <details className="text-xs text-ink-soft">
            <summary>Why it is unverified</summary>
            <ul className="mt-1 list-disc pl-5">
              {grounding.errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          </details>
        )}
        <span className="ml-auto text-[0.7rem] text-ink-faint" title="Trace id for debugging">
          trace {response.trace_id.slice(0, 8)}
        </span>
      </footer>
    </article>
  )
}

export function PendingAnswer() {
  return (
    <div className="rounded-r-lg border-l-[3px] border-l-rule bg-sheet/70 px-5 py-4" aria-live="polite">
      <p className="text-sm text-ink-soft">Checking every number against the tool results before showing the answer.</p>
      <div className="mt-3 space-y-2" aria-hidden="true">
        <Skeleton className="h-2.5 w-11/12" />
        <Skeleton className="h-2.5 w-8/12" />
      </div>
    </div>
  )
}
