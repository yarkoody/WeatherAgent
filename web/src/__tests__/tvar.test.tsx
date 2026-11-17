// Bad year = TVaR95 ("average lost days in the worst 1 in 20 years"), split by hazard family; no band on a bad-year ranking.
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LENS_EXPLAINER, badYearLines, badYearSteps } from '../lib/explain'
import type { HubScore, Ranking } from '../lib/types'
import { HubBreakdown } from '../widgets/HubBreakdown'
import { RankingWidget } from '../widgets/RankingWidget'
import { toolOutput } from './fixtures'

const base = toolOutput('chat-stream.sse', 'get_hub_risk') as HubScore
const ranking = toolOutput('chat-stream.sse', 'rank_hubs') as Ranking

function withShares(shares: Record<'winter' | 'flood' | 'hurricane' | 'severe_storm', number>): HubScore {
  const total = Object.values(shares).reduce((a, b) => a + b, 0)
  return {
    ...base,
    bad_year_days: total,
    families: Object.fromEntries(Object.entries(base.families).map(([f, fam]) => [f, { ...fam, bad_year_days: shares[f as keyof typeof shares] }])) as HubScore['families'],
  }
}

describe('bad-year wording (TVaR95)', () => {
  it('defines the bad year as the average of the worst 1 year in 20', () => {
    expect(LENS_EXPLAINER).toBe(
      'Typical year is the expected number of lost days. Bad year is the average across the worst 1 year in 20, because averages hide rare, severe events such as hurricanes.',
    )
    expect(LENS_EXPLAINER).not.toMatch(/1\\.645|standard deviation/)
  })

  it('names the hazard that drives most of the bad year, from the family shares', () => {
    const hub = withShares({ winter: 5, flood: 3, hurricane: 20, severe_storm: 2 })
    expect(badYearSteps(hub)).toEqual([
      'In the worst 1 year in 20, this hub loses on average about 30 days.',
      'Hurricanes drive most of that (20 days).',
      `In a typical year it loses about ${hub.exposure_days_per_year} days.`,
    ])
    expect(badYearLines(hub).join(' ')).toContain('hurricane 20')
  })

  it('says "the largest part" when no hazard is more than half', () => {
    const hub = withShares({ winter: 12, flood: 9, hurricane: 0, severe_storm: 9 })
    expect(badYearSteps(hub)[1]).toBe('Winter weather is the largest part (12 days).')
  })

  it('leaves the driver out when the family shares are missing (older data)', () => {
    const hub = { ...base, families: Object.fromEntries(Object.entries(base.families).map(([f, fam]) => [f, { ...fam, bad_year_days: undefined }])) } as unknown as HubScore
    expect(badYearSteps(hub)).toHaveLength(2)
  })
})

describe('hub breakdown: what drives the bad year', () => {
  it('shows each hazard\'s share of the bad year', () => {
    render(<HubBreakdown data={withShares({ winter: 5, flood: 3, hurricane: 20, severe_storm: 2 })} />)
    expect(screen.getByRole('listitem', { name: /^Hurricane/ })).toHaveTextContent('20 in a bad year')
    expect(screen.getByRole('listitem', { name: /^Winter/ })).toHaveTextContent('5 in a bad year')
  })
})

describe('bad-year ranking without bands', () => {
  it('renders with band null and shows no band label', () => {
    const bad: Ranking = { ...ranking, kind: 'bad_year', hazard: 'overall', region: null, items: ranking.items.map((i) => ({ ...i, band: null })) }
    const { container } = render(<RankingWidget data={bad} />)
    expect(screen.getByRole('heading')).toHaveTextContent('Bad-year disruption days (1 in 20)')
    const fills = [...container.querySelectorAll('.recharts-bar-rectangle path')].map((p) => p.getAttribute('fill'))
    expect(fills.length).toBe(bad.items.length)
    expect(new Set(fills).size).toBe(1) // one neutral color, not band colors
    expect(fills[0]).toBe('#4a5b68') // neutral ink, no band meaning
  })
})
