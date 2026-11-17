// Formula v2: typical-year and bad-year lenses, family bands, hurricane probability, new Scores columns.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScoresView } from '../components/ScoresView'
import { DebugProvider } from '../lib/debug'
import { LENS_EXPLAINER, badYearLines, hurricaneLines } from '../lib/explain'
import { pct } from '../lib/format'
import type { HubComparison, HubScore, Ranking, ScoreRow, SecondOpinion } from '../lib/types'
import scoresJson from '../mocks/scores.json'
import opinionJson from '../mocks/second-opinion.json'
import { ComparisonCards } from '../widgets/ComparisonCards'
import { HubBreakdown } from '../widgets/HubBreakdown'
import { RankingWidget, rankingTitle } from '../widgets/RankingWidget'
import { toolOutput } from './fixtures'

const hub = toolOutput('chat-stream.sse', 'get_hub_risk') as HubScore
const ranking = toolOutput('chat-stream.sse', 'rank_hubs') as Ranking
const comparison = toolOutput('chat-stream-compare.sse', 'compare_hubs') as HubComparison
const scores = scoresJson as ScoreRow[]
const opinion = opinionJson as SecondOpinion

describe('explanations built from tool data', () => {
  it('bad-year lines cite the typical and bad-year days', () => {
    const lines = badYearLines(hub)
    expect(lines.join(' ')).toContain(`${hub.exposure_days_per_year} days`)
    expect(lines.join(' ')).toContain(`${hub.bad_year_days} days`)
    expect(LENS_EXPLAINER).toContain('worst 1 year in 20')
  })

  it('hurricane lines cite the probability, the NRI frequency and the band cut-offs', () => {
    const miami: HubScore = {
      ...hub,
      hurricane_10yr_probability_pct: 61.4,
      families: {
        ...hub.families,
        hurricane: {
          ...hub.families.hurricane,
          band: 'high',
          signals: [{ ...hub.families.hurricane.signals[0], raw: 0.091, normalized: 0.91, contribution: 0.91, note: null }],
        },
      },
    }
    const text = hurricaneLines(miami).join(' ')
    expect(text).toContain('61.4% chance')
    expect(text).toContain('0.091 events/year')
    expect(text).toContain(`medium from ${hub.band_thresholds.hurricane_medium_from_pct}%`)
    expect(text).toContain(`high from ${hub.band_thresholds.hurricane_high_from_pct}%`)
  })
})

describe('hub breakdown', () => {
  it('shows both lenses and a band chip per family, hurricane as a 10-year chance', async () => {
    render(<HubBreakdown data={hub} />)
    const typical = screen.getByRole('group', { name: 'Typical year' })
    expect(typical).toHaveTextContent(`${hub.exposure_days_per_year}`)
    const bad = screen.getByRole('group', { name: 'Bad year (1 in 20)' })
    expect(bad).toHaveTextContent(`${hub.bad_year_days}`)

    for (const f of ['winter', 'flood', 'severe_storm'] as const) {
      const item = screen.getByRole('listitem', { name: new RegExp(`^${hub.families[f].family === 'severe_storm' ? 'Severe storm' : f}`, 'i') })
      expect(item).toHaveAttribute('data-band', hub.families[f].band)
    }
    const hurricane = screen.getByRole('listitem', { name: /^Hurricane/ })
    expect(hurricane).toHaveTextContent(`${hub.hurricane_10yr_probability_pct}% chance in 10 years`)

    fireEvent.click(screen.getByRole('button', { name: 'About typical and bad years' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('worst 1 year in 20')
    fireEvent.click(within(dialog).getByRole('button', { name: 'More detail' }))
    expect(dialog).toHaveTextContent('average across the worst 1 year in 20')
  })
})

describe('history saved before formula v2', () => {
  it('a v1-shaped hub score still renders, without the v2 lens or bands', () => {
    const v1 = structuredClone(hub) as Partial<HubScore> & HubScore
    delete (v1 as Partial<HubScore>).bad_year_days
    delete (v1 as Partial<HubScore>).hurricane_10yr_probability_pct
    for (const f of Object.values(v1.families)) delete (f as Partial<typeof f>).band
    render(<HubBreakdown data={v1} />)
    expect(screen.getByRole('group', { name: 'Typical year' })).toHaveTextContent(`${hub.exposure_days_per_year}`)
    expect(screen.queryByRole('group', { name: 'Bad year (1 in 20)' })).not.toBeInTheDocument()
    expect(screen.queryByText(/chance in 10 years/)).not.toBeInTheDocument()

    const cmp = structuredClone(comparison)
    for (const h of cmp.hubs) delete (h as Partial<HubScore>).bad_year_days
    render(<ComparisonCards data={cmp} />)
    expect(screen.queryByText('Bad year (1 in 20)')).not.toBeInTheDocument()
  })
})

describe('comparison cards', () => {
  it('show typical and bad-year days for every hub', () => {
    render(<ComparisonCards data={comparison} />)
    for (const h of comparison.hubs) {
      const card = screen.getByRole('group', { name: new RegExp(h.hub_id, 'i') })
      expect(within(card).getByText('Bad year (1 in 20)')).toBeInTheDocument()
      expect(card).toHaveTextContent(`${h.bad_year_days} d`)
    }
  })
})

describe('ranking widget', () => {
  it('labels a bad-year ranking in days, without the 0-100 band lines', () => {
    const bad: Ranking = {
      ...ranking,
      kind: 'bad_year',
      hazard: 'overall',
      region: null,
      items: ranking.items.map((i, n) => ({ ...i, value: 40 - n * 3 })),
    }
    expect(rankingTitle(bad)).toBe('Bad-year disruption days (1 in 20)')
    const { container } = render(<RankingWidget data={bad} />)
    expect(screen.getByRole('heading')).toHaveTextContent('Bad-year disruption days (1 in 20)')
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(0)
    expect(rankingTitle({ ...bad, region: 'Midwest' })).toBe('Bad-year disruption days (1 in 20) in the Midwest')
  })
})

describe('scores table', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_USE_MOCKS', '')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url, 'http://test').pathname
        if (path === '/scores') return Response.json(scores)
        if (path === '/second-opinion') return Response.json({ ...opinion, rank_correlation: 0.87 })
        return Response.json({ detail: 'not found' }, { status: 404 })
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('has typical-year, bad-year and hurricane columns and sorts by each lens', async () => {
    render(
      <DebugProvider debug={false}>
        <ScoresView />
      </DebugProvider>,
    )
    for (const name of [/Typical year/, /Bad year/, /Hurricane/]) expect(await screen.findByRole('columnheader', { name })).toBeInTheDocument()

    const firstHub = () => within(screen.getAllByRole('row')[1]).getAllByRole('rowheader')[0]
    const top = (key: keyof ScoreRow) => [...scores].sort((a, b) => (b[key] as number) - (a[key] as number) || a.hub_id.localeCompare(b.hub_id))[0]

    fireEvent.click(screen.getByRole('button', { name: 'Bad year' }))
    await waitFor(() => expect(firstHub()).toHaveTextContent(top('bad_year_days').name.replace(/ Hub$/, '')))
    fireEvent.click(screen.getByRole('button', { name: 'Typical year' }))
    await waitFor(() => expect(firstHub()).toHaveTextContent(top('exposure_days_per_year').name.replace(/ Hub$/, '')))

    const miami = screen.getByRole('row', { name: /Miami/ })
    expect(miami).toHaveTextContent(pct(scores.find((r) => r.hub_id === 'miami')!.hurricane_10yr_probability_pct))
  })

  it('shows rank agreement in the JEV summary when the contract provides it', async () => {
    render(
      <DebugProvider debug={false}>
        <ScoresView />
      </DebugProvider>,
    )
    expect(await screen.findByText(/Rank agreement 0\.87/)).toBeInTheDocument()
  })
})
