// UI polish: hazard icons, date formatting, and the rebuilt Scores table (sorting, filters).
import { fireEvent, render, screen, within } from '@testing-library/react'
import { CloudLightning, CloudRainWind, Snowflake, Waves } from 'lucide-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HAZARD_ICON, HazardIcon } from '../components/HazardIcon'
import { ScoresView } from '../components/ScoresView'
import { DebugProvider } from '../lib/debug'
import { formatDate } from '../lib/format'
import type { ScoreRow } from '../lib/types'
import scoresJson from '../mocks/scores.json'

const scores = scoresJson as ScoreRow[]
const short = (r: ScoreRow) => r.name.replace(/ Hub$/, '')

describe('HazardIcon', () => {
  it('maps each hazard family to one distinct Lucide icon', () => {
    expect(HAZARD_ICON).toEqual({ winter: Snowflake, flood: Waves, hurricane: CloudRainWind, severe_storm: CloudLightning })
    expect(new Set(Object.values(HAZARD_ICON)).size).toBe(4)
  })

  it('is decorative by default and can carry a label', () => {
    const { container, rerender } = render(<HazardIcon hazard="winter" />)
    expect(container.querySelector('svg.lucide-snowflake')).toHaveAttribute('aria-hidden', 'true')
    rerender(<HazardIcon hazard="hurricane" label="Hurricane" />)
    expect(screen.getByRole('img', { name: 'Hurricane' })).toBeInTheDocument()
  })
})

describe('formatDate', () => {
  it('formats ISO dates without shifting the day', () => {
    expect(formatDate('2026-11-17')).toBe('Nov 17, 2026')
    expect(formatDate('2026-01-01')).toBe('Jan 1, 2026')
    expect(formatDate('2026-11-17T12:26:52+00:00')).toBe('Nov 17, 2026')
    expect(formatDate('not a date')).toBe('not a date')
  })
})

describe('Scores table', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCKS', '')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url, 'http://test').pathname
        if (path === '/scores') return Response.json(scores)
        return Response.json({ detail: 'not found' }, { status: 404 })
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  const view = async () => {
    render(
      <DebugProvider debug={false}>
        <ScoresView />
      </DebugProvider>,
    )
    await screen.findAllByRole('rowheader')
  }
  const hubOrder = () => screen.queryAllByRole('rowheader').map((th) => th.textContent ?? '')

  it('sorts by any column header, toggling direction', async () => {
    await view()
    const badYear = screen.getByRole('button', { name: 'Sort by Bad year' })
    fireEvent.click(badYear)
    const desc = [...scores].sort((a, b) => b.bad_year_days - a.bad_year_days || a.hub_id.localeCompare(b.hub_id))
    expect(hubOrder()[0]).toContain(short(desc[0]))
    expect(badYear.closest('th')).toHaveAttribute('aria-sort', 'descending')

    fireEvent.click(badYear)
    expect(badYear.closest('th')).toHaveAttribute('aria-sort', 'ascending')
    expect(hubOrder()[0]).toContain(short(desc.at(-1)!))

    fireEvent.click(screen.getByRole('button', { name: 'Sort by Hub' }))
    const alpha = [...scores].map(short).sort((a, b) => a.localeCompare(b))
    expect(hubOrder()[0]).toContain(alpha[0])
    expect(screen.getByRole('button', { name: 'Sort by Hurricane 10 yr' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sort by Biggest risk' })).toBeInTheDocument()
  })

  it('every sortable header reads label, then (i), then the sort arrow, whatever the column alignment', async () => {
    await view()
    const sortable = screen.getAllByRole('columnheader').filter((th) => th.querySelector('[data-sort-arrow]'))
    expect(sortable.length).toBeGreaterThan(5)
    const after = (a: Element, b: Element) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    let rightAligned = 0
    for (const th of sortable) {
      const label = within(th).getByRole('button', { name: /^Sort by / })
      const info = within(th).getAllByRole('button').find((b) => b !== label)! // the (i)
      const arrow = th.querySelector('[data-sort-arrow]')!
      expect(after(label, info), th.textContent ?? '').toBe(true)
      expect(after(info, arrow), th.textContent ?? '').toBe(true)
      const group = th.querySelector('[data-header-group]')!
      expect(group.className).not.toMatch(/flex-row-reverse/)
      expect(label.className).not.toMatch(/flex-row-reverse/)
      if (th.className.includes('text-right')) rightAligned++
    }
    expect(rightAligned).toBeGreaterThan(0) // numeric columns are covered too
  })

  it('the sort arrow sorts too', async () => {
    await view()
    const th = screen.getByRole('button', { name: 'Sort by Bad year' }).closest('th')!
    fireEvent.click(th.querySelector('[data-sort-arrow]')!)
    expect(th).toHaveAttribute('aria-sort', 'descending')
  })

  it('filters by region, exposure band and name, and resets', async () => {
    await view()
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'South' } })
    const south = scores.filter((r) => r.region === 'South')
    expect(hubOrder()).toHaveLength(south.length)
    expect(screen.getByText(`Showing ${south.length} of ${scores.length} hubs`)).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Exposure level'), { target: { value: 'high' } })
    expect(hubOrder()).toHaveLength(south.filter((r) => r.exposure_band === 'high').length || 0)

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }))
    expect(hubOrder()).toHaveLength(scores.length)

    fireEvent.change(screen.getByLabelText('Search hubs'), { target: { value: 'hou' } })
    expect(hubOrder()).toEqual([expect.stringContaining('Houston')])

    fireEvent.change(screen.getByLabelText('Search hubs'), { target: { value: 'zzz' } })
    expect(screen.getByText('No hubs match these filters.')).toBeInTheDocument()
  })

})

describe('filter select pills', () => {
  it('draw their own chevron inside the pill, which never blocks the click', async () => {
    vi.stubEnv('VITE_USE_MOCKS', '')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (new URL(url, 'http://t').pathname === '/scores' ? Response.json(scores) : Response.json({}, { status: 404 }))))
    render(
      <DebugProvider debug={false}>
        <ScoresView />
      </DebugProvider>,
    )
    await screen.findAllByRole('rowheader')
    for (const name of ['Region', 'Exposure level']) {
      const select = screen.getByLabelText(name)
      expect(select).toHaveClass('appearance-none', 'pr-[30px]')
      const chevron = select.parentElement!.querySelector('svg.lucide-chevron-down')!
      expect(chevron).toHaveClass('pointer-events-none', 'right-2.5')
    }
  })
})
