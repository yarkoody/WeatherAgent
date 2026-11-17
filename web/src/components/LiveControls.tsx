// Live voice in the composer: the "Live" button next to the mic, and the voice dock that replaces the text box
// while a session runs (orb, state, waveform, time left, mute, end).
import { AudioLinesIcon, MicIcon, MicOffIcon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { InputGroupButton } from '@/components/ui/input-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { UNSUPPORTED_HINT, type LiveState } from '@/lib/liveVoice'
import { useReducedMotion } from '@/lib/motion'

export interface LiveView {
  supported: boolean
  state: LiveState
  error: string | null
  hint: string | null
  interim: string
  endsAt?: number | null
  muted?: boolean
  start: () => void
  stop: () => void
  skip: () => void
  toggleMute?: () => void
  /** Waveform bar heights (0..1) from the live audio, or null when there is nothing to measure. */
  levels?: (n: number) => number[] | null
}

type DockState = Exclude<LiveState, 'off'>

export const LIVE_LABEL: Record<DockState, string> = {
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Checking the figures',
  speaking: 'Speaking',
}

/** One short hint under the label. */
export function liveHint(state: DockState, { muted = false, tools = 0 }: { muted?: boolean; tools?: number } = {}): string {
  if (muted && (state === 'listening' || state === 'speaking')) return 'Mic muted'
  switch (state) {
    case 'connecting':
      return 'Allow the microphone if asked'
    case 'listening':
      return "Pause when you're done"
    case 'thinking':
      return tools > 0 ? `Running ${tools} ${tools === 1 ? 'tool' : 'tools'}` : 'Every figure is checked first'
    case 'speaking':
      return 'Talk to interrupt, or tap the orb to skip'
  }
}

/** Off: start a hands-free conversation (the dock then takes the composer's place). */
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
  return (
    <Tooltip>
      <TooltipTrigger
        render={<InputGroupButton type="button" size="sm" variant="ghost" aria-label="Start live voice" disabled={disabled} onClick={live.start} />}
      >
        <AudioLinesIcon /> Live
      </TooltipTrigger>
      <TooltipContent>Talk hands-free: answers are checked, then read aloud</TooltipContent>
    </Tooltip>
  )
}

const CORE: Record<DockState | 'error', string> = {
  connecting: 'bg-muted-foreground/60',
  listening: 'bg-voice-listen',
  thinking: 'bg-voice-think',
  speaking: 'bg-voice-speak',
  error: 'bg-destructive',
}

/** The state orb: flat color plus motion. While speaking it is a button that skips the rest of the answer. */
export function Orb({ state, onSkip, reduced }: { state: DockState | 'error'; onSkip?: () => void; reduced: boolean }) {
  const core = CORE[state]
  const halo = reduced || state === 'thinking' || state === 'error' ? '' : `voice-halo-${state}`
  const body = (
    <span className="relative grid size-10 place-items-center" aria-hidden="true">
      {state !== 'thinking' && state !== 'error' && <span className={`absolute inset-0 rounded-full opacity-30 ${core} ${halo}`} data-testid="orb-halo" />}
      {state === 'thinking' && (
        <span
          data-testid="orb-ring"
          className={`absolute inset-0.5 rounded-full border-2 border-voice-think/25 border-t-voice-think ${reduced ? '' : 'voice-ring-thinking'}`}
        />
      )}
      <span className={`relative size-5 rounded-full ${core}`} />
    </span>
  )
  if (state === 'speaking' && onSkip) {
    return (
      <button
        type="button"
        onClick={onSkip}
        aria-label="Skip the spoken answer"
        data-testid="orb"
        data-state={state}
        data-reduced={reduced}
        className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {body}
      </button>
    )
  }
  return (
    <span data-testid="orb" data-state={state} data-reduced={reduced} className="shrink-0">
      {body}
    </span>
  )
}

export const BARS = 36

/**
 * Bars drawn from the real audio (microphone while listening, the answer while speaking) on each animation frame.
 * Checking and connecting show a calm shimmer. The loop stops when the dock closes; reduced motion draws still bars.
 */
export function Waveform({ live, state, reduced, className }: { live: LiveView; state: DockState; reduced: boolean; className?: string }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([])
  const measured = state === 'listening' || state === 'speaking'
  useEffect(() => {
    if (!measured || reduced) return
    let frame = 0
    const tick = () => {
      const levels = live.levels?.(BARS) ?? null
      bars.current.forEach((el, i) => {
        if (el) el.style.transform = `scaleY(${Math.max(0.08, levels?.[i] ?? 0.08)})`
      })
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [live, measured, reduced])
  const tint = state === 'speaking' ? 'bg-voice-speak' : state === 'listening' ? 'bg-voice-listen' : state === 'thinking' ? 'bg-voice-think' : 'bg-muted-foreground'
  return (
    <span className={`h-8 items-center gap-[2px] ${className ?? 'flex'}`} aria-hidden="true" data-testid="waveform" data-mode={measured ? 'audio' : 'idle'}>
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            bars.current[i] = el
          }}
          className={`h-full w-[2px] origin-center rounded-full opacity-80 ${tint} ${!measured && !reduced ? 'voice-bar-idle' : ''}`}
          style={{
            transform: `scaleY(${measured ? 0.08 : 0.3})`,
            animationDelay: !measured && !reduced ? `${(i % 12) * 0.11}s` : undefined,
          }}
        />
      ))}
    </span>
  )
}

function useSecondsLeft(endsAt: number | null | undefined): number | null {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!endsAt) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [endsAt])
  return endsAt ? Math.max(0, Math.round((endsAt - now) / 1000)) : null
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

/**
 * The composer while Live is on: a rounded dock with the orb, the state and one hint, the waveform, time left,
 * mute and end. `error` shows a short line in the dock after a session ended on its own (the composer closes it).
 */
export function VoiceDock({ live, tools = 0, error, onClose }: { live: LiveView; tools?: number; error?: string | null; onClose?: () => void }) {
  const reduced = useReducedMotion()
  const endRef = useRef<HTMLButtonElement>(null)
  const left = useSecondsLeft(live.endsAt)
  const state: DockState = live.state === 'off' ? 'connecting' : live.state
  // Opening the dock removes the text box: keep keyboard focus inside the dock, on End.
  useEffect(() => {
    endRef.current?.focus({ preventScroll: true })
  }, [])

  const shell = 'glass flex min-h-14 w-full items-center gap-2.5 rounded-[28px] py-2 ps-2 pe-2 sm:gap-3'
  if (error) {
    return (
      <div className={shell} role="group" aria-label="Live voice" data-testid="voice-dock" data-state="error">
        <Orb state="error" reduced={reduced} />
        <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">
          {error}
        </p>
        <Button ref={endRef} type="button" variant="ghost" size="icon" className="rounded-full" aria-label="Close" onClick={onClose}>
          <XIcon />
        </Button>
      </div>
    )
  }
  return (
    <div className={shell} role="group" aria-label="Live voice" data-testid="voice-dock" data-state={state}>
      <Orb state={state} reduced={reduced} onSkip={live.skip} />
      <div className="min-w-0 flex-1" aria-live="polite" aria-atomic="true">
        <p className="truncate text-sm font-semibold" data-testid="live-label">
          {LIVE_LABEL[state]}
        </p>
        <p className="truncate text-xs text-muted-foreground" data-testid="live-hint">
          {live.hint ?? liveHint(state, { muted: live.muted, tools })}
        </p>
      </div>
      {/* On a phone the waveform goes first, so the controls keep their room. */}
      <Waveform live={live} state={state} reduced={reduced} className="hidden sm:flex" />
      {left !== null && (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums" data-testid="live-time" aria-label={`${clock(left)} left`}>
          {clock(left)}
        </span>
      )}
      {live.toggleMute && (
        <Button
          type="button"
          variant={live.muted ? 'secondary' : 'ghost'}
          size="icon"
          className="shrink-0 rounded-full"
          aria-label={live.muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={Boolean(live.muted)}
          onClick={live.toggleMute}
          disabled={state === 'connecting'}
        >
          {live.muted ? <MicOffIcon /> : <MicIcon />}
        </Button>
      )}
      <Button ref={endRef} type="button" variant="destructive" size="icon" className="shrink-0 rounded-full" aria-label="End live voice" onClick={live.stop}>
        <XIcon />
      </Button>
    </div>
  )
}
