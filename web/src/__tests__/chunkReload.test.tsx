// A stale tab after a deploy requests old lazy chunks (404): reload once instead of showing "could not be drawn".
import { render, screen, waitFor } from '@testing-library/react'
import { Suspense } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ErrorBoundary, WidgetFallback } from '../components/ErrorBoundary'
import { RELOAD_KEY, installChunkReload, lazyWithReload, page } from '../lib/chunkReload'

const missingChunk = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/RankingWidget-old.js'))

function renderLazy() {
  const Widget = lazyWithReload(missingChunk)
  render(
    <ErrorBoundary fallback={() => <WidgetFallback tool="rank_hubs" />}>
      <Suspense fallback={<p>Loading chart…</p>}>
        <Widget />
      </Suspense>
    </ErrorBoundary>,
  )
}

let reload: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  sessionStorage.clear()
  reload = vi.spyOn(page, 'reload').mockImplementation(() => {})
})
afterEach(() => reload.mockRestore())

describe('stale lazy chunks', () => {
  it('a missing widget chunk reloads the page once, and the error message never shows', async () => {
    renderLazy()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
    expect(sessionStorage.getItem(RELOAD_KEY)).not.toBeNull()
    expect(screen.getByText('Loading chart…')).toBeInTheDocument()
    expect(screen.queryByText(/could not be drawn/)).not.toBeInTheDocument()
  })

  it('does not loop: a second failure right after the reload shows the error instead', async () => {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    renderLazy()
    expect(await screen.findByText(/could not be drawn/)).toBeInTheDocument()
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads again once the guard window has passed', async () => {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now() - 60_000))
    renderLazy()
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1))
  })

  it('vite:preloadError reloads once and stops Vite from throwing', () => {
    installChunkReload()
    const first = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(first)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(first.defaultPrevented).toBe(true)
    const second = new Event('vite:preloadError', { cancelable: true })
    window.dispatchEvent(second)
    expect(reload).toHaveBeenCalledTimes(1) // guarded
    expect(second.defaultPrevented).toBe(false)
  })
})
