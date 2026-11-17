import { CircleCheckIcon, RotateCwIcon, TriangleAlertIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Grounding } from '@/lib/types'

const VARIANTS = {
  pass: {
    label: 'Numbers verified',
    title: 'Every number in this answer matches a tool result.',
    className: 'bg-band-low-soft text-[#2f6656]',
    Icon: CircleCheckIcon,
  },
  retried: {
    label: 'Verified after retry',
    title: 'The first draft cited a number no tool returned. It was corrected and then verified.',
    className: 'bg-isobar-soft text-isobar',
    Icon: RotateCwIcon,
  },
  failed: {
    label: 'Unverified',
    title: 'Some numbers could not be matched to tool results. Check them before use.',
    className: 'bg-band-high-soft text-[#9b2f2a]',
    Icon: TriangleAlertIcon,
  },
} as const

export function GroundingBadge({ grounding }: { grounding: Grounding }) {
  const v = VARIANTS[grounding.status] ?? VARIANTS.failed
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge className={v.className} data-status={grounding.status} />}>
        <v.Icon />
        {v.label}
      </TooltipTrigger>
      <TooltipContent>{v.title}</TooltipContent>
    </Tooltip>
  )
}
