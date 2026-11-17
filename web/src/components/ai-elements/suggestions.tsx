// AI Elements "Suggestion" pattern: the label is the message, sent as is.
// Chips shrink and wrap inside narrow screens (the button base is shrink-0 and sizes to its text).
import { Button } from '@/components/ui/button'
import { textDir } from '@/lib/textDir'

export function Suggestions({
  suggestions,
  onPick,
  disabled,
  align = 'center',
  label,
}: {
  suggestions: string[]
  onPick: (s: string) => void
  disabled?: boolean
  align?: 'center' | 'start'
  label?: string
}) {
  return (
    <div role={label ? 'group' : undefined} aria-label={label} className={`flex flex-wrap gap-2 ${align === 'center' ? 'justify-center' : 'justify-start'}`}>
      {suggestions.map((s) => (
        <Button key={s} dir={textDir(s)} variant="outline" size="sm" className="h-auto max-w-full min-w-0 shrink bg-card py-1.5 text-center whitespace-normal" disabled={disabled} onClick={() => onPick(s)}>
          {s}
        </Button>
      ))}
    </div>
  )
}
