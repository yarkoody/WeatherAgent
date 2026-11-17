// AI Elements "Prompt Input" pattern (shadcn/ui Input Group), with Web Speech API dictation.
// shadcn/ui has no speech-input pattern; its docs say to build it from Button and Spinner with the Web Speech API.
import { ArrowUpIcon, MicIcon, MicOffIcon, SquareIcon } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useDictation } from '@/lib/voice'
import { LiveButton, VoiceDock, type LiveView } from './LiveControls'

/** How long a live-voice error stays in the dock before the text box comes back. */
export const LIVE_ERROR_MS = 4000

const MAX = 2000

export const COMPOSER_INPUT_ID = 'chat-composer-input'

export function Composer({
  busy,
  onSend,
  onStop,
  live,
  liveTools = 0,
}: {
  busy: boolean
  onSend: (text: string) => void
  onStop: () => void
  live?: LiveView
  /** Tools the current turn has called, for the dock's "Running N tools" hint. */
  liveTools?: number
}) {
  const liveOn = Boolean(live && live.state !== 'off')
  // A session that ended with an error keeps the dock open briefly to say why, then the text box returns.
  const [liveError, setLiveError] = useState<string | null>(null)
  const liveErrorText = live?.state === 'off' ? live.error : null
  useEffect(() => {
    if (!liveErrorText) return
    setLiveError(liveErrorText)
    const id = setTimeout(() => setLiveError(null), LIVE_ERROR_MS)
    return () => clearTimeout(id)
  }, [liveErrorText])
  const docked = liveOn || liveError !== null
  // When the dock closes, put the keyboard back in the text box.
  const wasDocked = useRef(docked)
  useEffect(() => {
    if (wasDocked.current && !docked) input.current?.focus({ preventScroll: true })
    wasDocked.current = docked
  }, [docked])
  const [text, setText] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  // Dictation appends to whatever was already typed.
  const base = useRef('')
  const dictation = useDictation((t) => setText(base.current ? `${base.current} ${t}` : t))
  const input = useRef<HTMLTextAreaElement>(null)
  const startDictation = () => {
    base.current = text.trim()
    dictation.start()
    // Keep the keyboard in the text box, so Enter sends (focus left on the mic button made Enter stop listening).
    input.current?.focus()
  }

  const trimmed = text.trim()
  const canSend = !busy && trimmed.length > 0 && trimmed.length <= MAX

  function submit(e?: FormEvent) {
    e?.preventDefault()
    if (!canSend) return
    // Send exactly what is in the box (interim words included), then detach the recognizer: late results are ignored.
    dictation.finish()
    base.current = ''
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
      {docked && live && (
        <VoiceDock live={live} tools={liveTools} error={liveOn ? null : liveError} onClose={() => setLiveError(null)} />
      )}
      <InputGroup hidden={docked} className={`glass rounded-2xl border-(--glass-line) bg-transparent ${docked ? 'hidden' : ''}`}>
        <InputGroupTextarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          ref={input}
          onKeyDown={onKey}
          placeholder={dictation.listening ? 'Listening…' : 'Ask about a hub, a hazard or a ranking'}
          id={COMPOSER_INPUT_ID}
          aria-label="Ask about hub weather risk"
          dir="auto"
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
                    className={dictation.listening ? 'animate-pulse motion-reduce:animate-none' : undefined}
                    aria-pressed={dictation.listening}
                    aria-label={dictation.listening ? 'Stop dictation' : 'Dictate your question'}
                    onClick={dictation.listening ? dictation.stop : startDictation}
                    // Enter on the focused mic while listening sends, like in the text box; a click still only stops.
                    onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
                      if (dictation.listening && e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        formRef.current?.requestSubmit()
                      }
                    }}
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
          {live && <LiveButton live={live} disabled={dictation.listening} />}
          {dictation.listening && (
            <InputGroupText className="text-band-high-text" aria-live="polite">
              Listening…
            </InputGroupText>
          )}
          {!dictation.listening && dictation.hint && (
            <InputGroupText className="text-muted-foreground" aria-live="polite">
              {dictation.hint}
            </InputGroupText>
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
