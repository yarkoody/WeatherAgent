// Table → map: a pin per row, the row itself, or Enter shows the hub on the map (scroll up, center and zoom, one
// pulse, open its panel). Both directions highlight the same row and dot. Reduced motion: no smooth scroll, no pulse.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScoresView } from '../components/ScoresView'
import { DebugProvider } from '../lib/debug'
import type { Hub, HubScore, ScoreRow } from '../lib/types'
import hubScoresJson from '../mocks/hub-scores.json'
import hubsJson from '../mocks/hubs.json'
import scoresJson from '../mocks/scores.json'

const scores = scoresJson as ScoreRow[]
const hubs = hubsJson as Hub[]
const hubScores = hubScoresJson as unknown as Record<string, HubScore>

let scroll: ReturnType<typeof vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>>
const original = Element.prototype.scrollIntoView

function serve() {
  vi.stubEnv('VITE_USE_MOCKS', '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://test').pathname
      if (path === '/scores') return Response.json(scores)
      if (path === '/hubs') return Response.json(hubs)
      const m = /^\/hubs\/([a-z_]+)\/score$/.exec(path)
      if (m) return Response.json(hubScores[m[1]])
      return Response.json({ detail: 'not found' }, { status: 404 })
    }),
  )
}
/** matchMedia with prefers-reduced-motion on or off (other queries: no match). */
function motion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === '(prefers-reduced-motion: reduce)' ? reduce : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}
async function view() {
  render(
    <DebugProvider debug={false}>
      <ScoresView />
    </DebugProvider>,
  )
  await screen.findAllByRole('rowheader')
  return screen.findByRole('region', { name: 'Hub map' }, { timeout: 3000 })
}
const row = (id: string) => document.getElementById(`hub-row-${id}`)!
const mapScrolls = () => scroll.mock.contexts.filter((el) => (el as Element).id === 'hub-map')

beforeEach(() => {
  localStorage.clear()
  scroll = vi.fn<(arg?: boolean | ScrollIntoViewOptions) => void>()
  Element.prototype.scrollIntoView = scroll
  serve()
})
afterEach(() => {
  Element.prototype.scrollIntoView = original
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('show a hub on the map from the table', () => {
  it('the pin selects the hub on the map, opens its panel, highlights the row, scrolls up smoothly and pulses the dot', async () => {
    motion(false)
    const map = await view()
    fireEvent.click(screen.getByRole('button', { name: 'Show Miami on the map' }))
    expect(await within(map).findByRole('dialog', { name: 'Miami breakdown' })).toBeInTheDocument()
    expect(within(map).getByRole('button', { name: /^Miami: / })).toHaveAttribute('aria-pressed', 'true')
    expect(row('miami')).toHaveAttribute('data-selected', 'true')
    expect(mapScrolls()).toHaveLength(1)
    expect(scroll.mock.calls.find((_c, i) => (scroll.mock.contexts[i] as Element).id === 'hub-map')![0]).toEqual({ block: 'start', behavior: 'smooth' })
    expect(map.querySelector('[data-hub="miami"] [data-pulse]')).not.toBeNull()
  })

  it('clicking anywhere on the row does the same; clicks on buttons inside keep their own job', async () => {
    motion(false)
    const map = await view()
    fireEvent.click(within(row('houston')).getByText('Houston'))
    expect(await within(map).findByRole('dialog', { name: 'Houston breakdown' })).toBeInTheDocument()
    expect(row('houston')).toHaveAttribute('data-selected', 'true')
    // The (i) in a header and the sort buttons are not rows; a sort click must not open a panel for another hub.
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Bad year' }))
    expect(within(map).getByRole('dialog', { name: 'Houston breakdown' })).toBeInTheDocument()
  })

  it('keyboard: Enter on a focused row, or on the pin, shows the hub on the map', async () => {
    motion(false)
    const map = await view()
    const denver = row('denver')
    denver.focus()
    fireEvent.keyDown(denver, { key: 'Enter' })
    expect(await within(map).findByRole('dialog', { name: 'Denver breakdown' })).toBeInTheDocument()
    const pin = screen.getByRole('button', { name: 'Show Dallas on the map' })
    pin.focus()
    fireEvent.click(pin) // Enter on a button fires click
    expect(await within(map).findByRole('dialog', { name: 'Dallas breakdown' })).toBeInTheDocument()
    expect(row('dallas')).toHaveAttribute('data-selected', 'true')
    expect(row('denver')).toHaveAttribute('data-selected', 'false')
  })

  it('both directions agree: "Show in table" from the panel highlights the same row', async () => {
    motion(false)
    const map = await view()
    fireEvent.click(screen.getByRole('button', { name: 'Show Newark on the map' }))
    const panel = await within(map).findByRole('dialog', { name: 'Newark breakdown' })
    fireEvent.click(await within(panel).findByRole('button', { name: 'Show in table' }))
    await waitFor(() => expect(scroll.mock.contexts).toContain(row('newark')))
    expect(row('newark')).toHaveAttribute('data-selected', 'true')
    expect(within(map).getByRole('button', { name: /^Newark: / })).toHaveAttribute('aria-pressed', 'true')
  })

  it('reduced motion: an instant scroll and no pulse', async () => {
    motion(true)
    const map = await view()
    fireEvent.click(screen.getByRole('button', { name: 'Show Miami on the map' }))
    expect(await within(map).findByRole('dialog', { name: 'Miami breakdown' })).toBeInTheDocument()
    expect(scroll.mock.calls.find((_c, i) => (scroll.mock.contexts[i] as Element).id === 'hub-map')![0]).toEqual({ block: 'start', behavior: 'auto' })
    expect(map.querySelector('[data-pulse]')).toBeNull()
  })
})
