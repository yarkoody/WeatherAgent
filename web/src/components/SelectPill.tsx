import { ChevronDownIcon } from 'lucide-react'
import type { ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * A native select styled as a pill: the browser arrow is hidden and a chevron sits inside the pill,
 * 10 px from the right edge and 6 px after the label. The chevron ignores the pointer, so the whole pill opens the menu.
 */
export function SelectPill({ className, children, ...props }: ComponentProps<'select'>) {
  return (
    <span className="relative inline-flex">
      <select
        {...props}
        className={cn(
          'h-9 cursor-pointer appearance-none rounded-xl border border-border/70 bg-background/70 py-0 pr-[30px] pl-3 text-sm text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none',
          className,
        )}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    </span>
  )
}
