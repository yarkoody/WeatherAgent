// AI Elements "Suggestion" pattern: the label is the message, sent as is.
import { Button } from '@/components/ui/button'

export function Suggestions({ suggestions, onPick, disabled }: { suggestions: string[]; onPick: (s: string) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {suggestions.map((s) => (
        <Button key={s} variant="outline" size="sm" className="h-auto bg-card py-1.5 whitespace-normal" disabled={disabled} onClick={() => onPick(s)}>
          {s}
        </Button>
      ))}
    </div>
  )
}
