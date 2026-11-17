import { useCallback, useEffect, useRef, useState } from 'react'

// Minimal Web Speech API typings (not in lib.dom for all TS versions).
interface SpeechRecognitionResultLike {
  0: { transcript: string }
  isFinal: boolean
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: ArrayLike<SpeechRecognitionResultLike>
}
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  start(): void
  stop(): void
}
type RecognitionCtor = new () => SpeechRecognitionLike

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Push-to-talk dictation. `onText` receives the running transcript (interim, then final). */
export function useDictation(onText: (text: string, final: boolean) => void) {
  const supported = recognitionCtor() !== null
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<SpeechRecognitionLike | null>(null)
  const cb = useRef(onText)
  cb.current = onText

  const stop = useCallback(() => rec.current?.stop(), [])

  const start = useCallback(() => {
    const Ctor = recognitionCtor()
    if (!Ctor) return
    const r = new Ctor()
    r.lang = 'en-US'
    r.interimResults = true
    r.continuous = false
    r.onresult = (e) => {
      let text = ''
      let final = false
      for (let i = 0; i < e.results.length; i++) {
        text += e.results[i][0].transcript
        final = e.results[i].isFinal
      }
      cb.current(text.trim(), final)
    }
    r.onerror = (e) => {
      setError(e.error === 'not-allowed' ? 'Microphone access is blocked. Allow it in the browser to dictate.' : `Voice input stopped: ${e.error}.`)
    }
    r.onend = () => setListening(false)
    rec.current = r
    setError(null)
    setListening(true)
    r.start()
  }, [])

  useEffect(() => () => rec.current?.stop(), [])

  return { supported, listening, error, start, stop }
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined'
}

/** Markdown to plain text that reads well aloud. */
export function toSpeech(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function speak(text: string): void {
  if (!speechSupported()) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(toSpeech(text))
  u.lang = 'en-US'
  window.speechSynthesis.speak(u)
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel()
}
