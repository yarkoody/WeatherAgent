// Audio levels for the live-voice waveform: one AudioContext per live session, an AnalyserNode on the microphone
// and one on the spoken answer. The context is created inside the Live click, so autoplay rules let it run.

export type MeterSource = 'mic' | 'speaker'

export interface Meter {
  /** Measure this microphone stream (never routed to the speakers). */
  mic(stream: MediaStream): void
  /**
   * Measure this audio element and play it through the context. An element can be connected to a context only once,
   * so live voice keeps one element for the whole session; later calls with the same element do nothing.
   */
  speaker(el: HTMLAudioElement): void
  /** `n` bar heights in 0..1, mirrored around the middle, or null when that source is not connected. */
  read(source: MeterSource, n: number): number[] | null
  resume(): void
  close(): void
}

type Ctor = typeof AudioContext

/** Voice energy sits in the low bins (about 100 Hz to 4 kHz with a 256-point FFT at 48 kHz). */
const BINS = 32

/** Turn analyser bins into `n` bars: half from the bins, mirrored, so the waveform is symmetric. */
export function barsFromBins(bins: ArrayLike<number>, n: number): number[] {
  const half = Math.ceil(n / 2)
  const out: number[] = []
  const usable = Math.min(BINS, bins.length - 1)
  for (let i = 0; i < half; i++) {
    const from = 1 + Math.floor((i * usable) / half)
    const to = Math.max(from + 1, 1 + Math.floor(((i + 1) * usable) / half))
    let sum = 0
    for (let b = from; b < to; b++) sum += bins[b] ?? 0
    const v = sum / (to - from) / 255
    out.push(Math.min(1, Math.pow(v, 0.8) * 1.15))
  }
  const left = [...out].reverse()
  return [...left, ...out].slice(0, n)
}

export function createMeter(): Meter | null {
  const w = typeof window === 'undefined' ? undefined : (window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor })
  const Ctx = w?.AudioContext ?? w?.webkitAudioContext
  if (!Ctx) return null
  let ctx: AudioContext
  try {
    ctx = new Ctx()
  } catch {
    return null
  }
  const analyser = () => {
    const a = ctx.createAnalyser()
    a.fftSize = 256
    a.smoothingTimeConstant = 0.75
    return a
  }
  const micA = analyser()
  const spkA = analyser()
  let micSrc: MediaStreamAudioSourceNode | null = null
  let el: HTMLAudioElement | null = null
  let spkOk = false
  const buf = new Uint8Array(micA.frequencyBinCount)
  const resume = () => {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  }
  resume()
  return {
    mic(stream) {
      try {
        micSrc?.disconnect()
        micSrc = ctx.createMediaStreamSource(stream)
        micSrc.connect(micA)
      } catch {
        micSrc = null
      }
    },
    speaker(audio) {
      if (el === audio) return
      el = audio
      try {
        const src = ctx.createMediaElementSource(audio)
        src.connect(spkA)
        spkA.connect(ctx.destination) // the element now plays through the context
        spkOk = true
      } catch {
        spkOk = false // still plays on its own; the waveform just stays idle
      }
      resume()
    },
    read(source, n) {
      if (source === 'mic' ? !micSrc : !spkOk) return null
      ;(source === 'mic' ? micA : spkA).getByteFrequencyData(buf)
      return barsFromBins(buf, n)
    },
    resume,
    close() {
      micSrc?.disconnect()
      void ctx.close().catch(() => {})
    },
  }
}
