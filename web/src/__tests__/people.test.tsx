// People impact lens: people served (metro estimate, a proxy) and people-days, on the Scores table, the map,
// the hub breakdown, the comparison table, the ranking widget and the primer. Older data (0 / missing) hides it.
import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HowScoresWork } from '../components/HowScoresWork'
import { ScoresView } from '../components/ScoresView'
import { DebugProvider } from '../lib/debug'
import { PEOPLE_DAYS_LINE } from '../lib/explain'
import { compact, fmt, hasPeople, hubName } from '../lib/format'
import type { Hub, HubComparison, HubScore, Ranking, ScoreRow } from '../lib/types'
import hubScoresJson from '../mocks/hub-scores.json'
import hubsJson from '../mocks/hubs.json'
import scoresJson from '../mocks/scores.json'
import { ComparisonCards } from '../widgets/ComparisonCards'
import { HubBreakdown } from '../widgets/HubBreakdown'
import { RankingWidget, rankingTitle } from '../widgets/RankingWidget'
import { toolOutput } from './fixtures'

const scores = scoresJson as ScoreRow[]
const hubs = hubsJson as Hub[]
const hubScores = hubScoresJson as unknown as Record<string, HubScore>
const cmp = toolOutput('chat-stream-compare.sse', 'compare_hubs') as HubComparison
const ranking = toolOutput('chat-stream.sse', 'rank_hubs') as Ranking

function serve(rows: ScoreRow[] = scores) {
  vi.stubEnv('VITE_USE_MOCKS', '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://test').pathname
      if (path === '/scores') return Response.json(rows)
      if (path === '/hubs') return Response.json(hubs)
      return Response.json({ detail: 'not found' }, { status: 404 })
    }),
  )
}
const view = async () => {
  render(
    <DebugProvider debug={false}>
      <ScoresView />
    </DebugProvider>,
  )
  await screen.findAllByRole('rowheader')
}
/** A row as an older backend sends it: ScoreRow defaults people fields to 0 / "". */
const withoutPeople = (r: ScoreRow): ScoreRow => ({ ...r, metro_name: '', people_served: 0, people_days_m: 0, people_days_bad_year_m: 0 })

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Scores table', () => {
  it('people served (compact) and people-days (M/yr) columns, units in the headers, bad year on hover, sortable', async () => {
    serve()
    await view()
    const served = screen.getByRole('button', { name: 'Sort by People served' }).closest('th')!
    expect(served).toHaveTextContent('People served(metro, est.)')
    expect(screen.getByRole('button', { name: 'Sort by People-days' }).closest('th')).toHaveTextContent('People-days(M/yr)')

    const top = [...scores].sort((a, b) => b.people_served! - a.people_served!)[0]
    fireEvent.click(screen.getByRole('button', { name: 'Sort by People served' }))
    const first = screen.getAllByRole('row')[1]
    expect(first).toHaveTextContent(top.name.replace(/ Hub$/, ''))
    expect(first).toHaveTextContent(compact(top.people_served))
    const pd = within(first).getByText(fmt(top.people_days_m))
    expect(pd).toHaveAttribute('title', `Bad year: ${fmt(top.people_days_bad_year_m)} million people-days`)
  })

  it('an older backend (0 people) shows n/a, sorts last, and is never shown as 0', async () => {
    serve(scores.map(withoutPeople))
    await view()
    const row = screen.getAllByRole('row')[1]
    expect(within(row).getAllByText('n/a')).toHaveLength(2)
    expect(hasPeople(withoutPeople(scores[0]))).toBe(false)
  })
})

describe('map', () => {
  it('"Color by" switches to people impact: the legend and the dot labels change with the mode', async () => {
    serve()
    await view()
    const map = await screen.findByRole('region', { name: 'Hub map' }, { timeout: 3000 })
    const legend = within(map).getByTestId('map-legend')
    expect(within(legend).getByRole('button', { name: 'Biggest risk' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(within(legend).getByRole('button', { name: 'People impact' }))
    expect(within(legend).getByRole('button', { name: 'People impact' })).toHaveAttribute('aria-pressed', 'true')
    expect(legend).toHaveTextContent('million people-days a year')
    expect(legend).toHaveTextContent("Dot size: people served (metro population, an estimate, not the hub's customers)")
    expect(within(legend).queryByRole('list', { name: 'Biggest risk colors' })).not.toBeInTheDocument()
    const chicago = scores.find((r) => r.hub_id === 'chicago')!
    expect(within(map).getByRole('button', { name: /^Chicago: / })).toHaveAccessibleName(
      `Chicago: ${fmt(chicago.people_days_m)} million people-days a year, ${compact(chicago.people_served)} people served (metro estimate)`,
    )
    fireEvent.click(within(legend).getByRole('button', { name: 'Biggest risk' }))
    expect(within(legend).getByRole('list', { name: 'Biggest risk colors' })).toBeInTheDocument()
  })

  it('without people data the People impact mode is disabled and says why', async () => {
    serve(scores.map(withoutPeople))
    await view()
    const map = await screen.findByRole('region', { name: 'Hub map' }, { timeout: 3000 })
    expect(within(map).getByRole('button', { name: 'People impact' })).toBeDisabled()
    expect(within(map).getByTestId('map-legend')).toHaveTextContent('People impact appears when the scores include it.')
  })
})

describe('hub breakdown and comparison', () => {
  it('the breakdown lists people served and people-days (typical and bad year) with the plain line', () => {
    const hub = hubScores.chicago
    render(<HubBreakdown data={hub} />)
    const block = screen.getByRole('region', { name: 'People impact' })
    expect(block).toHaveTextContent(`People served (metro)${compact(hub.people_served)}`)
    expect(block).toHaveTextContent(`People-days, typical (M/yr)${fmt(hub.people_days_m)}`)
    expect(block).toHaveTextContent(`People-days, bad year (M/yr)${fmt(hub.people_days_bad_year_m)}`)
    expect(block).toHaveTextContent(PEOPLE_DAYS_LINE)
    expect(block).toHaveTextContent("an estimate, not the hub's customers")
  })

  it('the breakdown hides the block for older data', () => {
    render(<HubBreakdown data={{ ...hubScores.chicago, people_served: undefined, people_days_m: undefined }} />)
    expect(screen.queryByRole('region', { name: 'People impact' })).not.toBeInTheDocument()
  })

  it('the comparison table adds people served and people-days (bad year underneath) and the plain line', () => {
    render(<ComparisonCards data={cmp} />)
    for (const h of cmp.hubs) {
      const row = screen.getByRole('rowheader', { name: hubName(h.hub_id) }).closest('tr')!
      expect(row.querySelector('td[data-column="people"]')).toHaveTextContent(compact(h.people_served))
      expect(row.querySelector('td[data-column="people_days"]')).toHaveTextContent(`${fmt(h.people_days_m)}bad year ${fmt(h.people_days_bad_year_m)}`)
    }
    expect(screen.getByTestId('compare-people')).toHaveTextContent(PEOPLE_DAYS_LINE)
  })
})

describe('ranking and primer', () => {
  it('a people_impact ranking has its own title, neutral bars and the people-days note', () => {
    const people: Ranking = { ...ranking, kind: 'people_impact', hazard: 'overall', region: null, items: ranking.items.map((i) => ({ ...i, band: null })) }
    expect(rankingTitle(people)).toBe('People-days if disrupted (million a year)')
    expect(rankingTitle({ ...people, region: 'Midwest' })).toBe('People-days if disrupted in the Midwest (million a year)')
    const { container } = render(<RankingWidget data={people} />)
    expect(screen.getByRole('heading')).toHaveTextContent('People-days if disrupted (million a year)')
    expect(container.textContent).toContain(PEOPLE_DAYS_LINE)
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(0)
    const fills = [...container.querySelectorAll('.recharts-bar-rectangle path')].map((p) => p.getAttribute('fill'))
    expect(new Set(fills).size).toBe(1)
  })

  it('"How the scores work" explains people served as a proxy and how it enters priority', () => {
    render(<HowScoresWork rows={scores} />)
    expect(document.body.textContent).toContain('People served is the metro-area population, a Census estimate used as a stand-in for the people a hub serves (not its customers).')
    expect(document.body.textContent).toContain('More people raise review priority')
  })
})

describe('wording from the independent review', () => {
  it('people-days read "if the hub is disrupted", never "how many people feel the disruption"; tips say computed before rounding', async () => {
    expect(PEOPLE_DAYS_LINE).toBe('People-days: if the hub is disrupted, the people it serves (metro estimate) × lost days a year. Computed before rounding.')
    serve()
    await view()
    expect(document.body.textContent).not.toMatch(/feel the disruption/)
    fireEvent.click(screen.getByRole('button', { name: 'About review priority' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('computed before rounding')
  })

  it('review priority is labelled typical year and shows the bad year beside it (breakdown and comparison)', () => {
    const miami = hubScores.miami
    render(<HubBreakdown data={miami} />)
    expect(screen.getByText('Review priority (typical year)')).toBeInTheDocument()
    expect(screen.getByTestId('priority-bad-year')).toHaveTextContent(`Bad year: ${fmt(miami.bad_year_days)} lost days`)
    render(<ComparisonCards data={cmp} />)
    for (const h of cmp.hubs) {
      const row = screen.getByRole('rowheader', { name: hubName(h.hub_id) }).closest('tr')!
      expect(row.querySelector('td[data-column="priority"] [data-sub]')).toHaveTextContent(`bad year ${fmt(h.bad_year_days)} days`)
    }
  })
})

describe('ranking kinds', () => {
  const base = { ...ranking, hazard: 'overall' as const, region: null, items: ranking.items.map((i) => ({ ...i, band: null })) }

  it('people_served: its own title, compact people values, no 35/60 lines, neutral bars', () => {
    const served: Ranking = { ...base, kind: 'people_served', items: base.items.map((i, k) => ({ ...i, value: [20_100_000, 9_434_123, 4_300_000][k] ?? 1_000_000 })) }
    expect(rankingTitle(served)).toBe('People served (metro estimate)')
    const { container } = render(<RankingWidget data={served} />)
    expect(screen.getByRole('heading')).toHaveTextContent('People served (metro estimate)')
    expect(screen.getByRole('heading')).not.toHaveTextContent(/Exposure/)
    expect(container.querySelector('svg.recharts-surface')!.textContent).toContain('20.1M')
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(0)
  })

  it('an unknown kind never falls back to "Exposure" or band lines', () => {
    const odd = { ...base, kind: 'something_new' as Ranking['kind'] }
    const { container } = render(<RankingWidget data={odd} />)
    expect(screen.getByRole('heading')).toHaveTextContent('Hub ranking')
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(0)
  })

  it('a ranking with one hub is a compact stat card (hub, value, unit), not a one-bar chart', () => {
    const one: Ranking = { ...base, kind: 'people_served', region: 'Northeast', total: 1, items: [{ ...base.items[0], name: 'Newark Hub', hub_id: 'newark', value: 20_100_000 }] }
    const { container } = render(<RankingWidget data={one} />)
    const stat = screen.getByTestId('ranking-stat')
    expect(stat).toHaveTextContent('Newark')
    expect(stat).toHaveTextContent('20.1M')
    expect(stat).toHaveTextContent('people (metro estimate)')
    expect(container.querySelector('svg.recharts-surface')).toBeNull()
  })

  it('banded rankings show a level chip on the single-hub card', () => {
    const one: Ranking = { ...ranking, total: 1, items: [ranking.items[0]] }
    render(<RankingWidget data={one} />)
    expect(within(screen.getByTestId('ranking-stat')).getByText(/High|Medium|Low/)).toBeInTheDocument()
  })
})

describe('banned wording', () => {
  it('no UI source says "feel the disruption" or "top driver"', async () => {
    const { readdirSync, readFileSync, statSync } = await import('node:fs')
    const { join, resolve } = await import('node:path')
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f)
        return statSync(p).isDirectory() ? (f === '__tests__' || f === 'mocks' ? [] : walk(p)) : /\.(tsx?|css)$/.test(f) ? [p] : []
      })
    for (const file of walk(resolve(process.cwd(), 'src'))) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/feel the disruption|top driver|Top driver/)
    }
  })
})
