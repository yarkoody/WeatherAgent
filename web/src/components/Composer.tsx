// AI Elements "Prompt Input" pattern (shadcn/ui Input Group), with Web Speech API dictation.
// shadcn/ui has no speech-input pattern; its docs say to build it from Button and Spinner with the Web Speech API.
import { ArrowUpIcon, MicIcon, MicOffIcon, SquareIcon } from 'lucide-react'
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDictation } from '@/lib/voice'

const MAX = 2000

export function Composer({ busy, onSend, onStop }: { busy: boolean; onSend: (text: string) => void; onStop: () => void }) {
  const [text, setText] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  // Dictation appends to whatever was already typed.
  const base = useRef('')
  const dictation = useDictation((t) => setText(base.current ? `${base.current} ${t}` : t))
  const startDictation = () => {
    base.current = text.trim()
    dictation.start()
  }

  const trimmed = text.trim()
  const canSend = !busy && trimmed.length > 0 && trimmed.length <= MAX

  function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!canSend) return
    dictation.stop()
    onSend(trimmed)
    setText('')
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      formRef.current?.requestSubmit()
    }
  }

  return (
    <form ref={formRef} onSubmit={submit} className="w-full">
      <InputGroup className="bg-white">
        <InputGroupTextarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={dictation.listening ? 'Listening…' : 'Ask about a hub, a hazard or a ranking'}
          aria-label="Ask about hub weather risk"
          className="min-h-14 text-base"
        />
        <InputGroupAddon align="block-end" className="pt-1">
          {dictation.supported ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    type="button"
                    size="icon-sm"
                    variant={dictation.listening ? 'destructive' : 'ghost'}
                    aria-pressed={dictation.listening}
                    aria-label={dictation.listening ? 'Stop dictation' : 'Dictate your question'}
                    onClick={dictation.listening ? dictation.stop : startDictation}
                  />
                }
              >
                <MicIcon />
              </TooltipTrigger>
              <TooltipContent>{dictation.listening ? 'Stop dictation' : 'Dictate your question'}</TooltipContent>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger render={<InputGroupButton type="button" size="icon-sm" variant="ghost" aria-disabled="true" aria-label="Voice input is not supported in this browser" className="opacity-50" />}>
                <MicOffIcon />
              </TooltipTrigger>
              <TooltipContent>Voice input needs a browser with speech recognition, such as Chrome, Edge or Safari.</TooltipContent>
            </Tooltip>
          )}
          {dictation.error && <InputGroupText className="text-destructive">{dictation.error}</InputGroupText>}
          {trimmed.length > MAX - 200 && (
            <InputGroupText className={trimmed.length > MAX ? 'text-destructive' : undefined}>
              {trimmed.length} / {MAX}
            </InputGroupText>
          )}
          {busy ? (
            <InputGroupButton type="button" variant="outline" size="sm" className="ml-auto" onClick={onStop}>
              <SquareIcon className="fill-current" /> Stop
            </InputGroupButton>
          ) : (
            <InputGroupButton type="submit" variant="default" size="icon-sm" className="ml-auto" disabled={!canSend} aria-label="Ask">
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
