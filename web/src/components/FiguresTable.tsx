import { FigureCitation } from '@/components/ai-elements/inline-citation'
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatValue, hubName } from '@/lib/format'
import type { Figure } from '@/lib/types'

export function FiguresTable({ figures }: { figures: Figure[] }) {
  if (figures.length === 0) return null
  return (
    <Table className="text-sm">
      <TableCaption className="mt-0 mb-2 caption-top text-left text-xs font-semibold text-muted-foreground">
        Figures behind this answer
      </TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>Figure</TableHead>
          <TableHead>Hub</TableHead>
          <TableHead className="text-right">Value</TableHead>
          <TableHead>Source</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {figures.map((f, i) => (
          <TableRow key={`${f.hub_id}-${f.label}-${i}`}>
            <TableCell className="whitespace-normal">{f.label}</TableCell>
            <TableCell className="text-muted-foreground">{f.hub_id ? hubName(f.hub_id) : 'General'}</TableCell>
            <TableCell className="text-right font-semibold">{formatValue(f.value, f.unit)}</TableCell>
            <TableCell>
              <FigureCitation figure={f} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
