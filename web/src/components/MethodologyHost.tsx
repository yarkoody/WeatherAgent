// Hosts the Methodology view in a wide side sheet; opened from anywhere with openMethodology().
import { Suspense, useEffect, useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { lazyWithReload } from '@/lib/chunkReload'
import { onOpenMethodology } from '@/lib/methodology'

// react-markdown, remark-math, rehype-katex and KaTeX load only when the view opens.
const MethodologyView = lazyWithReload(() => import('@/components/MethodologyView').then((m) => ({ default: m.MethodologyView })))

export function MethodologyHost() {
  const [state, setState] = useState<{ open: boolean; anchor?: string }>({ open: false })
  useEffect(() => onOpenMethodology((anchor) => setState({ open: true, anchor })), [])
  return (
    <Sheet open={state.open} onOpenChange={(open) => setState((s) => ({ ...s, open }))}>
      <SheetContent side="right" className="glass gap-0 overflow-hidden p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-4xl" aria-describedby={undefined}>
        <SheetHeader className="border-b border-border/60 px-5 py-4">
          <SheetTitle className="heading-tight text-lg">Methodology</SheetTitle>
          <SheetDescription>How every number is computed.</SheetDescription>
        </SheetHeader>
        {state.open && (
          <Suspense fallback={<Skeleton className="m-5 h-64 rounded-2xl" />}>
            <MethodologyView anchor={state.anchor} />
          </Suspense>
        )}
      </SheetContent>
    </Sheet>
  )
}
