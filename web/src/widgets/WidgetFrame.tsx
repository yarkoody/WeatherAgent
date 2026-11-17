import type { ReactNode } from 'react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { Band } from '@/lib/types'

export function WidgetFrame({ title, note, children, label }: { title: ReactNode; note?: ReactNode; children: ReactNode; label: string }) {
  return (
    <Card size="sm" className="w-full" aria-label={label} role="region">
      <CardHeader>
        <CardTitle role="heading" aria-level={3} className="font-wide font-semibold tracking-tight">{title}</CardTitle>
        {note && <CardDescription className="text-xs">{note}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

const BAND_CLASS: Record<Band, string> = {
  low: 'bg-band-low-soft text-[#2f6656]',
  medium: 'bg-band-medium-soft text-[#7a5612]',
  high: 'bg-band-high-soft text-[#9b2f2a]',
}

export function BandPill({ band }: { band: Band }) {
  return <Badge className={BAND_CLASS[band]}>{band[0].toUpperCase() + band.slice(1)}</Badge>
}
