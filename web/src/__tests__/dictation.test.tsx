// Dictation keeps listening until the user stops (or sends), across the browser ending its sessions.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../components/Composer'

interface Result {
  0: { transcript: string }
  isFinal: boolean
  length: number
}

/** Fake Web Speech API recognizer: each instance is one browser "session". */
class FakeRecognition {
  static instances: FakeRecognition[] = []
  lang = ''
  continuous = false
  interimResults = false
  onresult: ((e: { resultIndex: number; results: Result[] }) => void) | null = null
  onerror: ((e: { error: string }) => void) | null = null
  onend: (() => void) | null = null
  started = 0
  stopped = 0
  results: Result[] = []
  constructor() {
    FakeRecognition.instances.push(this)
  }
  start() {
    this.started++
    this.results = []
  }
  stop() {
    this.stopped++
  }
  abort() {
    this.stopped++
  }
  /** The browser hears speech: final unless `interim`. */
  say(text: string, interim = false) {
    const last = this.results.at(-1)
    if (last && !last.isFinal) this.results.pop()
    this.results.push({ 0: { transcript: text }, isFinal: !interim, length: 1 })
    act(() => this.onresult?.({ resultIndex: this.results.length - 1, results: [...this.results] }))
  }
  /** The browser ends the session on its own (silence, time limit) or after stop(). */
  end() {
    act(() => this.onend?.())
  }
  fail(error: string) {
    act(() => this.onerror?.({ error }))
  }
}

const current = () => FakeRecognition.instances.at(-1)!
const box = () => screen.getByLabelText('Ask about hub weather risk') as HTMLTextAreaElement
const mic = () => screen.getByRole('button', { name: /Dictate your question|Stop dictation/ })

beforeEach(() => {
  FakeRecognition.instances = []
  vi.stubGlobal('SpeechRecognition', FakeRecognition)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('dictation', () => {
  it('uses continuous recognition with interim results and shows a listening state', () => {
    render(<Composer busy={false} onSend={() => {}} onStop={() => {}} />)
    fireEvent.click(mic())
    expect(current().continuous).toBe(true)
    expect(current().interimResults).toBe(true)
    expect(mic()).toHaveAttribute('aria-pressed', 'true')
    expect(box()).toHaveAttribute('placeholder', 'Listening…')
  })

  it('restarts when the browser ends the session on its own, keeping the text', () => {
    render(<Composer busy={false} onSend={() => {}} onStop={() => {}} />)
    fireEvent.click(mic())
    current().say('rank the Midwest hubs')
    const first = current()
    first.end() // silence or the browser's time limit, not the user
    expect(FakeRecognition.instances.length + first.started).toBeGreaterThan(2) // a new session started
    expect(mic()).toHaveAttribute('aria-pressed', 'true')
    current().say('by winter exposure')
    expect(box().value).toBe('rank the Midwest hubs by winter exposure')
  })

  it('appends to what was already typed, and interim text is replaced by the final words', () => {
    render(<Composer busy={false} onSend={() => {}} onStop={() => {}} />)
    fireEvent.change(box(), { target: { value: 'Compare Houston' } })
    fireEvent.click(mic())
    current().say('and Dal', true)
    expect(box().value).toBe('Compare Houston and Dal')
    current().say('and Dallas')
    expect(box().value).toBe('Compare Houston and Dallas')
  })

  it('a manual stop does not restart', () => {
    render(<Composer busy={false} onSend={() => {}} onStop={() => {}} />)
    fireEvent.click(mic())
    const rec = current()
    const sessions = FakeRecognition.instances.length
    fireEvent.click(mic()) // stop
    expect(rec.stopped).toBe(1)
    rec.end()
    expect(FakeRecognition.instances.length).toBe(sessions)
    expect(rec.started).toBe(1)
    expect(mic()).toHaveAttribute('aria-pressed', 'false')
  })

  it('no-speech and aborted are not errors; the session just continues', () => {
    render(<Composer busy={false} onSend={() => {}} onStop={() => {}} />)
    fireEvent.click(mic())
    current().fail('no-speech')
    current().end()
    current().fail('aborted')
    current().end()
    expect(screen.queryByText(/Voice input stopped|blocked/)).not.toBeInTheDocument()
    expect(mic()).toHaveAttribute('aria-pressed', 'true')
  })

  it('stops after about 8 seconds without new speech, with a gentle hint', () => {
    vi.useFakeTimers()
    render(<Composer busy={false} onSend={() => {}} onStop={() => {}} />)
    fireEvent.click(mic())
    current().say('rank hubs')
    act(() => vi.advanceTimersByTime(7_000))
    expect(mic()).toHaveAttribute('aria-pressed', 'true')
    act(() => vi.advanceTimersByTime(1_500))
    current().end()
    expect(mic()).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByText('Stopped listening')).toBeInTheDocument()
  })

  it('sending the message stops listening', () => {
    const onSend = vi.fn()
    render(<Composer busy={false} onSend={onSend} onStop={() => {}} />)
    fireEvent.click(mic())
    current().say('rank hubs')
    const rec = current()
    fireEvent.submit(box().closest('form')!)
    expect(onSend).toHaveBeenCalledWith('rank hubs')
    expect(rec.stopped).toBe(1)
    rec.end()
    expect(mic()).toHaveAttribute('aria-pressed', 'false')
  })
})
