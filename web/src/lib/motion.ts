import { createContext, createElement, useContext, useEffect, useState, type ReactNode } from 'react'
import { useMediaQuery } from './useMediaQuery'

const hasMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function'

const MotionOff = createContext(false)

/** Renders its children without motion: used for messages restored from history, so a reload does not replay animations. */
export function NoMotion({ children }: { children: ReactNode }) {
  return createElement(MotionOff.Provider, { value: true }, children)
}

/** True when the user asked for reduced motion, inside NoMotion, or where motion cannot be detected (tests, old browsers). */
export function useReducedMotion(): boolean {
  const off = useContext(MotionOff)
  const reduce = useMediaQuery('(prefers-reduced-motion: reduce)')
  return off || reduce || !hasMatchMedia()
}

/** Counts a number up from zero once, in about 400 ms. Shows the final value at once under reduced motion. */
export function useCountUp(target: number, duration = 400): number {
  const reduced = useReducedMotion()
  const [value, setValue] = useState(reduced ? target : 0)
  useEffect(() => {
    if (reduced) {
      setValue(target)
      return
    }
    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - (1 - t) ** 3
      setValue(t === 1 ? target : target * eased)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, duration, reduced])
  return value
}
