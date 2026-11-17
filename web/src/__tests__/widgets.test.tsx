import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { shortHubName } from '../lib/format'
import type { ActiveAlerts, HubScore, Ranking } from '../lib/types'
import { AlertBanner } from '../widgets/AlertBanner'
import { HubBreakdown } from '../widgets/HubBreakdown'
import { RankingWidget, rankingTitle } from '../widgets/RankingWidget'
import { toolOutput } from './fixtures'

// Widget inputs come from tool outputs in a stream recorded from the real backend.
const ranking = toolOutput('chat-stream.sse', 'rank_hubs') as Ranking
const hubScore = toolOutput('chat-stream.sse', 'get_hub_risk') as HubScore

describe('RankingWidget', () => {
  it('draws every ranked hub with its tool value and the band thresholds', () => {
    const { container } = render(<RankingWidget data={ranking} />)
    expect(screen.getByRole('heading')).toHaveTextContent(rankingTitle(ranking))
    expect(rankingTitle(ranking)).toBe('Winter exposure in the Midwest')
    for (const item of ranking.items) {
      expect(screen.getAllByText(shortHubName(item.name)).length).toBeGreaterThan(0)
    }
    const svgText = container.querySelector('svg.recharts-surface')?.textContent ?? ''
    expect(svgText).toContain(String(ranking.items[0].value))
    // a hazard ranking is banded by that hazard's lost days, so the 0-100 index lines (35/60) are not drawn
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(0)
    // bars are colored by band
    const fills = [...container.querySelectorAll('.recharts-bar-rectangle path')].map((p) => p.getAttribute('fill'))
    expect(fills[0]).toBe('#C2413B') // first item is in the high band
  })
})

describe('RankingWidget, overall exposure', () => {
  it('marks the 35 and 60 index band lines', () => {
    const overall: Ranking = { ...ranking, hazard: 'overall' }
    const { container } = render(<RankingWidget data={overall} />)
    const svgText = container.querySelector('svg.recharts-surface')?.textContent ?? ''
    expect(container.querySelectorAll('.recharts-reference-line')).toHaveLength(2)
    expect(svgText).toContain('35')
    expect(svgText).toContain('60')
  })
})

describe('HubBreakdown', () => {
  it('leads with disruption days and highlights the top driver', () => {
    render(<HubBreakdown data={hubScore} />)
    expect(screen.getByText(String(hubScore.exposure_days_per_year))).toBeInTheDocument()
    expect(screen.getByText('modeled lost days/yr, typical year (estimate)')).toBeInTheDocument()
    expect(screen.getByText('Top driver')).toBeInTheDocument()
    for (const u of hubScore.upgrade_categories) expect(screen.getByText(u)).toBeInTheDocument()
  })
})

describe('AlertBanner', () => {
  it('renders nothing when there are no alerts', () => {
    const empty: ActiveAlerts = { hub_id: 'houston', alerts: [], fetched_at: '2026-11-17T21:40:00+00:00' }
    const { container } = render(<AlertBanner data={empty} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('lists live alerts from the recorded stream', () => {
    const alerts = toolOutput('chat-stream-alerts.sse', 'get_active_alerts') as ActiveAlerts
    render(<AlertBanner data={alerts} />)
    expect(screen.getByText('2 active NWS alerts for Houston')).toBeInTheDocument()
    expect(screen.getByText('Flood Watch')).toBeInTheDocument()
  })
})
