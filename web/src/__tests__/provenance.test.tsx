// Data sources: one short line per source with its period or vintage, fed by data (a mock until the endpoint lands).
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DataSources } from '../components/DataSources'
import { HowScoresWork } from '../components/HowScoresWork'
import { PROVENANCE_ENDPOINT, loadProvenance, provenanceLines, type Provenance } from '../lib/provenance'
import mock from '../mocks/provenance.json'
import type { ScoreRow } from '../lib/types'
import scores from '../mocks/scores.json'

const provenance = mock as Provenance

describe('data sources', () => {
  it('renders one line per source from the data, flagged as a placeholder while it is the mock', () => {
    render(<DataSources provenance={provenance} />)
    const section = screen.getByRole('region', { name: 'Data sources' })
    expect(within(section).getAllByRole('listitem')).toHaveLength(provenance.sources.length)
    for (const s of provenance.sources) expect(section).toHaveTextContent(`${s.name}: ${s.detail}`)
    expect(section).toHaveTextContent('placeholder until the provenance endpoint lands')
  })

  it('appears at the end of "How the scores work"', () => {
    render(<HowScoresWork rows={scores as ScoreRow[]} provenance={provenance} />)
    expect(screen.getByRole('region', { name: 'Data sources' })).toBeInTheDocument()
  })

  it('shows nothing without data, and the live app shows nothing until the endpoint is set', async () => {
    const { container } = render(<DataSources provenance={null} />)
    expect(container).toBeEmptyDOMElement()
    expect(PROVENANCE_ENDPOINT).toBeNull()
    expect(await loadProvenance()).toBeNull() // tests run without VITE_USE_MOCKS
  })

  it('export lines: "<source>: <period or vintage>"', () => {
    expect(provenanceLines(provenance)).toEqual(provenance.sources.map((s) => `${s.name}: ${s.detail}`))
    expect(provenanceLines(null)).toEqual([])
  })
})
