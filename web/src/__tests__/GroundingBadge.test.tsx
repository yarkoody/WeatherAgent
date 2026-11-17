import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { AnswerCard } from '../components/AnswerCard'
import { GroundingBadge } from '../components/GroundingBadge'
import { DebugProvider } from '../lib/debug'
import mock from '../mocks/chat-response.json'
import type { ChatResponse } from '../lib/types'

const response = mock as ChatResponse

describe('GroundingBadge', () => {
  it.each([
    ['pass', 'Figures checked'],
    ['retried', 'Figures checked after retry'],
    ['failed', 'Unverified'],
  ] as const)('shows %s as "%s"', (status, label) => {
    render(<GroundingBadge grounding={{ status, errors: [] }} />)
    const badge = screen.getByText(label)
    expect(badge).toHaveAttribute('data-status', status)
  })

  it('renders the mock answer with a verified badge', () => {
    render(<AnswerCard response={response} />)
    expect(screen.getByText('Figures checked')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('warns and lists the errors when grounding failed', () => {
    const failed: ChatResponse = { ...response, grounding: { status: 'failed', errors: ['43 is not in figures'] } }
    render(
      <DebugProvider debug>
        <AnswerCard response={failed} />
      </DebugProvider>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('could not be matched')
    expect(screen.getByText('43 is not in figures')).toBeInTheDocument()
  })

  it('shows distinct out-of-scope and no-data states', () => {
    const oos: ChatResponse = { ...response, answer: { ...response.answer, in_scope: false, figures: [] } }
    const { unmount } = render(<AnswerCard response={oos} />)
    expect(screen.getByLabelText('Answer')).toHaveAttribute('data-kind', 'out_of_scope')
    expect(screen.getByText('Outside what this assistant covers')).toBeInTheDocument()
    expect(screen.queryByText('Figures checked')).not.toBeInTheDocument()
    unmount()

    const noData: ChatResponse = { ...response, answer: { ...response.answer, data_available: false, figures: [] } }
    render(<AnswerCard response={noData} />)
    expect(screen.getByLabelText('Answer')).toHaveAttribute('data-kind', 'no_data')
    expect(screen.getByText('No data for this question')).toBeInTheDocument()
  })
})

describe('AnswerCard markdown', () => {
  it('renders a GFM table and strikethrough from answer text instead of raw pipes', () => {
    const text = [
      'Winter exposure:',
      '',
      '| Hub | Winter exposure index |',
      '| --- | ---: |',
      '| Minneapolis | 85.3 |',
      '| Chicago | 41.7 |',
      '',
      'Old figure ~~40~~ is gone.',
    ].join('\n')
    const withTable: ChatResponse = { ...response, answer: { ...response.answer, answer: text, figures: [] } }
    render(<AnswerCard response={withTable} />)
    const table = screen.getByRole('table')
    expect(table).toHaveTextContent('Winter exposure index')
    expect(screen.getAllByRole('row')).toHaveLength(3)
    expect(screen.getByRole('cell', { name: '85.3' })).toBeInTheDocument()
    expect(screen.queryByText(/\| Hub \|/)).not.toBeInTheDocument()
    expect(screen.getByText('40').tagName).toBe('DEL')
  })
})
