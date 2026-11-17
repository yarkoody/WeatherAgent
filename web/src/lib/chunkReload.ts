// After a redeploy, an open tab still points at the old build's lazy chunks (RankingWidget-<oldhash>.js), which
// now 404. The standard fix: reload the page once to pick up the new build. A sessionStorage timestamp stops a
// reload loop when the chunk is missing for another reason (offline, a broken deploy).
import { lazy, type ComponentType } from 'react'

export const RELOAD_KEY = 'weather-risk.chunk-reload-at'
const WINDOW_MS = 30_000

/** Indirection so tests can observe the reload (jsdom's location.reload cannot be stubbed). */
export const page = { reload: () => window.location.reload() }

/** Reloads the page unless it already reloaded for this reason in the last 30 s. Returns true when reloading. */
export function reloadOnce(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < WINDOW_MS) return false
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    return false // no storage: never risk a loop
  }
  page.reload()
  return true
}

/** Vite fires this when a preloaded chunk or CSS fails to load. */
export function installChunkReload() {
  window.addEventListener('vite:preloadError', (event) => {
    if (reloadOnce()) event.preventDefault()
  })
}

/** React.lazy that reloads once instead of throwing when the chunk is gone (stale tab after a deploy). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((error: unknown) => {
      // While the page reloads, stay suspended (the fallback shows) rather than flash the error boundary.
      if (reloadOnce()) return new Promise<{ default: T }>(() => {})
      throw error
    }),
  )
}
