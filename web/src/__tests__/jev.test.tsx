// JEV second opinion in the Scores view.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScoresView } from '../components/ScoresView'
import { DebugProvider } from '../lib/debug'
import type { SecondOpinion } from '../lib/types'
import scores from '../mocks/scores.json'
import opinionJson from '../mocks/second-opinion.json'

const opinion = opinionJson as SecondOpinion
const LOCAL_ONLY = 'JEV re-run is only available when running locally.'

type Route = { status: number; body: unknown }

/** Stub the backend: /scores always works; /second-opinion and the rerun answer as given. */
function serve(get: Route, rerun: Route = { status: 503, body: { detail: LOCAL_ONLY } }) {
  const calls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://test').pathname
      calls.push(`${init?.method ?? 'GET'} ${path}`)
      if (path === '/scores') return Response.json(scores)
      if (path === '/second-opinion/rerun') return Response.json(rerun.body, { status: rerun.status })
      if (path === '/second-opinion') return Response.json(get.body, { status: get.status })
      return Response.json({ detail: 'not found' }, { status: 404 })
    }),
  )
  return calls
}

const view = (debug = false) =>
  render(
    <DebugProvider debug={debug}>
      <ScoresView />
    </DebugProvider>,
  )

beforeEach(() => vi.stubEnv('VITE_USE_MOCKS', ''))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('second opinion column', () => {
  it('shows the summary and each hub agree count, with disagreements marked', async () => {
    serve({ status: 200, body: opinion })
    view()
    expect(await screen.findByRole('columnheader', { name: /Second opinion \(JEV\)/ })).toBeInTheDocument()
    expect(screen.getByText(`JEV agrees with the formula on ${opinion.agree_count} of ${opinion.total} ratings (${opinion.agreement_pct}%).`)).toBeInTheDocument()

    const houston = screen.getByRole('row', { name: /Houston/ })
    const cell = within(houston).getByRole('button', { name: /JEV second opinion for Houston: 3 of 4 agree/ })
    expect(cell).toHaveAttribute('data-disagrees', 'true')
    const atlanta = screen.getByRole('row', { name: /Atlanta/ })
    expect(within(atlanta).getByRole('button', { name: /4 of 4 agree/ })).toHaveAttribute('data-disagrees', 'false')

    fireEvent.click(cell)
    const dialog = await screen.findByRole('dialog')
    const flood = opinion.hubs.find((h) => h.hub_id === 'houston')!.families.find((f) => f.family === 'flood')!
    const row = within(dialog).getByRole('row', { name: /Flood/ })
    expect(row).toHaveAttribute('data-agrees', 'false')
    expect(row).toHaveTextContent(`${flood.jev_score_pct}%`)
    expect(row).toHaveTextContent(/differs/i)
  })

  it('a 404 hides the column and the summary without an error', async () => {
    serve({ status: 404, body: { detail: 'No second opinion yet.' } })
    view(true)
    await screen.findByRole('row', { name: /Chicago/ })
    expect(screen.queryByRole('columnheader', { name: /Second opinion/ })).not.toBeInTheDocument()
    expect(screen.queryByText(/JEV agrees/)).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('narrow screens', () => {
  it('collapses the column into a compact badge next to the hub name', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(max-width: 639px)', addEventListener() {}, removeEventListener() {} }))
    serve({ status: 200, body: opinion })
    view()
    const houston = await screen.findByRole('button', { name: /JEV second opinion for Houston: 3 of 4 agree/ })
    expect(screen.queryByRole('columnheader', { name: /Second opinion/ })).not.toBeInTheDocument()
    expect(houston.closest('th')).toHaveTextContent('Houston')
  })
})

describe('re-run JEV', () => {
  it('is only offered in the developer view', async () => {
    serve({ status: 200, body: opinion })
    view(false)
    await screen.findByRole('columnheader', { name: /Second opinion/ })
    expect(screen.queryByRole('button', { name: 'Re-run JEV' })).not.toBeInTheDocument()
  })

  it('shows the 503 detail when re-running is not available here', async () => {
    const calls = serve({ status: 200, body: opinion })
    view(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run JEV' }))
    expect(await screen.findByText(LOCAL_ONLY)).toBeInTheDocument()
    expect(calls).toContain('POST /second-opinion/rerun')
  })

  it('refreshes the column after a successful re-run', async () => {
    const fresh: SecondOpinion = { ...opinion, agree_count: 60, agreement_pct: 100, run_at: '2026-11-18T08:00:00+00:00' }
    serve({ status: 200, body: opinion }, { status: 200, body: fresh })
    view(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Re-run JEV' }))
    await waitFor(() => expect(screen.getByText(/JEV agrees with the formula on 60 of 60 ratings \(100%\)\./)).toBeInTheDocument())
  })
})
