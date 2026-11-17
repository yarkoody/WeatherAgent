import { InfoIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * "How is this calculated?" button. A popover (not a hover tooltip) so it opens on tap and on Enter.
 * `lines` must be built from tool output only (see lib/explain.ts).
 */
export function InfoTip({ subject, lines, note }: { subject: string; lines: string[]; note?: string }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded-full text-muted-foreground hover:text-foreground"
            aria-label={`How is the ${subject} calculated?`}
          />
        }
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] gap-2 text-xs leading-relaxed">
        <p className="text-sm font-medium">How the {subject} is calculated</p>
        <ul className="space-y-1 text-muted-foreground">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
        {note && <p className="border-t pt-2 text-muted-foreground">{note}</p>}
      </PopoverContent>
    </Popover>
  )
}
