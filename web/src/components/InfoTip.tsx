import { InfoIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/**
 * "How is this calculated?" button. A popover (not a hover tooltip) so it opens on tap and on Enter.
 * `steps` are short plain-language lines (at most five); `detail` is the technical breakdown, shown on request.
 * Both must be built from tool output only (see lib/explain.ts).
 */
export function InfoTip({
  subject,
  steps,
  detail,
  title,
  icon,
  legend,
}: {
  subject: string
  steps?: string[]
  /** Term and meaning pairs, shown as a short glossary ("How to read this"). */
  legend?: { term: string; text: string }[]
  detail?: string[]
  title?: string
  /** Optional glyph before the title, e.g. a HazardIcon. */
  icon?: ReactNode
}) {
  const [more, setMore] = useState(false)
  const lines = steps ?? []
  const numbered = lines.length > 1
  return (
    <Popover onOpenChange={(open) => !open && setMore(false)}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-5 rounded-full text-muted-foreground/70 hover:text-foreground"
            aria-label={title ?? `How is the ${subject} calculated?`}
          />
        }
      >
        <InfoIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] gap-2 text-sm leading-snug">
        <p className="flex items-center gap-1.5 font-medium">
          {icon}
          {title ?? `How the ${subject} is calculated`}
        </p>
        {legend && legend.length > 0 && (
          <dl className="space-y-1.5">
            {legend.map((e) => (
              <div key={e.term}>
                <dt className="inline font-medium text-foreground">{e.term}: </dt>
                <dd className="inline text-muted-foreground">{e.text}</dd>
              </div>
            ))}
          </dl>
        )}
        {numbered ? (
          <ol className="list-decimal space-y-1.5 pl-5 text-muted-foreground marker:text-foreground/60">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ol>
        ) : (
          lines[0] && <p className="text-muted-foreground">{lines[0]}</p>
        )}
        {detail && detail.length > 0 && (
          <div className="border-t pt-2">
            <Button variant="link" size="xs" className="h-auto px-0 text-xs" aria-expanded={more} onClick={() => setMore((m) => !m)}>
              {more ? 'Less detail' : 'More detail'}
            </Button>
            {more && (
              <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground">
                {detail.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
