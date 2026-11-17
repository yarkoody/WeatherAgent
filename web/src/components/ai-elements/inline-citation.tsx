// AI Elements "Inline Citation" pattern (shadcn/ui Hover Card): the figure cites the tool that returned it.
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { formatValue, hubName } from '@/lib/format'
import type { Figure } from '@/lib/types'

export function FigureCitation({ figure }: { figure: Figure }) {
  return (
    <HoverCard>
      <HoverCardTrigger delay={10} closeDelay={100} render={<Button variant="secondary" size="xs" className="font-mono" />}>
        {figure.source_tool}
      </HoverCardTrigger>
      <HoverCardContent className="flex w-64 flex-col gap-1 text-sm">
        <div className="font-medium">
          {figure.label}: {formatValue(figure.value, figure.unit)}
        </div>
        <p className="text-muted-foreground">
          Returned by the <code>{figure.source_tool}</code> tool{figure.hub_id ? ` for ${hubName(figure.hub_id)}` : ''}. The grounding check
          matched it to that tool's output before the answer was shown.
        </p>
      </HoverCardContent>
    </HoverCard>
  )
}
