// AI Elements "Inline Citation" pattern (shadcn/ui Hover Card): the figure cites the tool that returned it.
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { formatValue, hubName } from '@/lib/format'
import type { Figure } from '@/lib/types'

/** Hover text. Only claims a match when grounding passed (or passed on retry). */
/** The field a figure came from, as a path in the tool result: "families.winter.days_per_year" or "priority". */
export function fieldPath(figure: Figure): string | null {
  if (!figure.source_field) return null
  return figure.family ? `families.${figure.family}.${figure.source_field}` : figure.source_field
}

export function citationText(figure: Figure, verified: boolean): string {
  const where = `the ${figure.source_tool} tool${figure.hub_id ? ` for ${hubName(figure.hub_id)}` : ''}`
  return verified
    ? `Returned by ${where}${fieldPath(figure) ? ` (field ${fieldPath(figure)})` : ''}. The grounding check found it in that tool's output before the answer was shown.`
    : `Cited as coming from ${where}, but the grounding check could not be matched to the tool results. Do not rely on it.`
}

export function FigureCitation({ figure, verified }: { figure: Figure; verified: boolean }) {
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={10}
        closeDelay={100}
        aria-label={`Source: ${figure.source_tool}, ${verified ? 'verified' : 'not verified'}`}
        render={<Button variant={verified ? 'secondary' : 'outline'} size="xs" className={verified ? 'font-mono' : 'font-mono text-destructive'} />}
      >
        {figure.source_tool}
      </HoverCardTrigger>
      <HoverCardContent className="flex w-64 flex-col gap-1 text-sm">
        <div className="font-medium">
          {figure.label}: {formatValue(figure.value, figure.unit)}
          {!verified && <span className="ml-1.5 text-destructive">(unverified)</span>}
        </div>
        <p className="text-muted-foreground">{citationText(figure, verified)}</p>
      </HoverCardContent>
    </HoverCard>
  )
}
