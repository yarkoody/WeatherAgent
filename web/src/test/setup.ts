import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

afterEach(() => cleanup())

// jsdom has no layout and no ResizeObserver. Recharts' ResponsiveContainer (inside shadcn's ChartContainer)
// sizes itself from ResizeObserver, so report a fixed 560x300 box.
class RO {
  constructor(private cb: ResizeObserverCallback) {}
  observe(target: Element) {
    const rect = { width: 560, height: 300, top: 0, left: 0, right: 560, bottom: 300, x: 0, y: 0 }
    this.cb([{ target, contentRect: rect } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = RO as unknown as typeof ResizeObserver

// jsdom has no layout: stub scrolling.
Element.prototype.scrollIntoView ??= function scrollIntoView() {}
