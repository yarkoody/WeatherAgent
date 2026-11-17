import { CircleCheckIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Grounding } from '@/lib/types'

const VARIANTS = {
  pass: {
    label: 'Figures checked',
    title: 'Each figure in this answer was checked against the scoring data it cites.',
    className: 'bg-band-low-soft text-band-low-text',
    Icon: CircleCheckIcon,
  },
  retried: {
    label: 'Figures checked after retry',
    title: 'The first draft cited a number no tool returned. It was corrected and then checked.',
    className: 'bg-isobar-soft text-isobar',
    Icon: RotateCwIcon,
  },
  failed: {
    label: 'Unverified',
    title: 'Some numbers could not be matched to tool results. Check them before use.',
    className: 'bg-band-high-soft text-band-high-text',
    Icon: TriangleAlertIcon,
  },
} as const

export function GroundingBadge({ grounding }: { grounding: Grounding }) {
  const v = VARIANTS[grounding.status] ?? VARIANTS.failed
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge tabIndex={0} className={v.className} data-status={grounding.status} aria-description={v.title} />}>
        <v.Icon />
        {v.label}
      </TooltipTrigger>
      <TooltipContent>{v.title}</TooltipContent>
    </Tooltip>
  )
}
