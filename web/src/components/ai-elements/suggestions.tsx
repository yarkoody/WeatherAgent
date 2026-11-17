// AI Elements "Suggestion" pattern: the label is the message, sent as is.
import { Button } from '@/components/ui/button'

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
        <Button key={s} variant="outline" size="sm" className="h-auto bg-card py-1.5 whitespace-normal" disabled={disabled} onClick={() => onPick(s)}>
          {s}
        </Button>
      ))}
    </div>
  )
}
