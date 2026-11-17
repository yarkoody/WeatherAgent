// Live voice controls for the composer: a "Live" button next to the mic, and a status bar while a session runs.
import { AudioLinesIcon, LoaderCircleIcon, SkipForwardIcon, SquareIcon } from 'lucide-react'
import { InputGroupButton } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UNSUPPORTED_HINT, type LiveState } from '@/lib/liveVoice'

export interface LiveView {
  supported: boolean
  state: LiveState
  error: string | null
  hint: string | null
  interim: string
  start: () => void
  stop: () => void
  skip: () => void
}

export const LIVE_STATE_TEXT: Record<LiveState, string> = {
  off: 'Live voice is off',
  connecting: 'Connecting…',
  listening: 'Listening… ask your question',
  thinking: 'Thinking… checking the figures',
  speaking: 'Speaking… talk to interrupt',
}

/** Off: start a hands-free conversation. On: the same spot is the Stop button. */
export function LiveButton({ live, disabled }: { live: LiveView; disabled?: boolean }) {
  if (!live.supported) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<InputGroupButton type="button" size="sm" variant="ghost" aria-disabled="true" aria-label={`Live voice: ${UNSUPPORTED_HINT}`} className="opacity-50" />}
        >
          <AudioLinesIcon /> Live
        </TooltipTrigger>
        <TooltipContent>{UNSUPPORTED_HINT}</TooltipContent>
      </Tooltip>
    )
  }
  const on = live.state !== 'off'
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InputGroupButton
            type="button"
            size="sm"
            variant={on ? 'destructive' : 'ghost'}
            aria-pressed={on}
            aria-label={on ? 'Stop live voice' : 'Start live voice'}
            disabled={!on && disabled}
            onClick={on ? live.stop : live.start}
          />
        }
      >
        {on ? <SquareIcon className="fill-current" /> : <AudioLinesIcon />} {on ? 'End live' : 'Live'}
      </TooltipTrigger>
      <TooltipContent>{on ? 'Stop live voice' : 'Talk hands-free: answers are checked, then read aloud'}</TooltipContent>
    </Tooltip>
  )
}

const DOT: Record<LiveState, string> = {
  off: 'bg-muted-foreground',
  connecting: 'bg-muted-foreground',
  listening: 'bg-band-low animate-pulse motion-reduce:animate-none',
  thinking: 'bg-band-medium',
  speaking: 'bg-isobar animate-pulse motion-reduce:animate-none',
}

/** What the live session is doing, plus the words heard so far. Shows the last error after it stops. */
export function LiveStatus({ live }: { live: LiveView }) {
  if (live.state === 'off') {
    return live.error ? (
      <p role="alert" data-testid="live-status" className="px-2 pb-1 text-xs text-destructive">
        {live.error}
      </p>
    ) : null
  }
  return (
    <div data-testid="live-status" data-state={live.state} className="flex flex-wrap items-center gap-2 px-2 pb-1 text-xs" aria-live="polite">
      {live.state === 'connecting' || live.state === 'thinking' ? (
        <LoaderCircleIcon className="size-3.5 animate-spin text-muted-foreground motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <span className={`size-2 rounded-full ${DOT[live.state]}`} aria-hidden="true" />
      )}
      <span className="font-medium">{LIVE_STATE_TEXT[live.state]}</span>
      {live.interim && <span className="min-w-0 truncate text-muted-foreground italic">“{live.interim}”</span>}
      {live.hint && <span className="text-muted-foreground">{live.hint}</span>}
      {live.state === 'speaking' && (
        <button type="button" onClick={live.skip} className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground hover:text-foreground">
          <SkipForwardIcon className="size-3.5" /> Skip
        </button>
      )}
    </div>
  )
}
