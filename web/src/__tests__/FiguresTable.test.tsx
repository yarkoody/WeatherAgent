import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FiguresTable } from '../components/FiguresTable'
import { DebugProvider } from '../lib/debug'
import mock from '../mocks/chat-response.json'
import type { ChatResponse } from '../lib/types'

const { figures } = (mock as ChatResponse).answer

describe('FiguresTable', () => {
  it('renders one row per figure from the mock answer, values exactly as given (developer view shows sources)', () => {
    render(
      <DebugProvider debug>
        <FiguresTable figures={figures} verified />
      </DebugProvider>,
    )
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(rows).toHaveLength(figures.length)
    figures.forEach((f, i) => {
      const cells = within(rows[i]).getAllByRole('cell')
      expect(cells[0]).toHaveTextContent(f.label)
      expect(cells[2]).toHaveTextContent(String(f.value))
      expect(cells[3]).toHaveTextContent(f.source_tool)
    })
    expect(rows[0]).toHaveTextContent('Minneapolis')
  })

  it('formats percentages and labels general figures', () => {
    render(<FiguresTable verified figures={[{ hub_id: null, label: 'snow days', value: 11.8, unit: '%', source_tool: 'weather_stat' }]} />)
    expect(screen.getByText('11.8%')).toBeInTheDocument()
    expect(screen.getByText('General')).toBeInTheDocument()
  })

  it('shows source_field (with its family path) next to the source tool, in developer mode only', () => {
    const figs = [
      { hub_id: 'denver', label: 'winter days', value: 12.1, unit: 'days/year', source_tool: 'get_hub_risk', source_field: 'days_per_year', family: 'winter' as const },
      { hub_id: 'denver', label: 'priority', value: 40.2, unit: 'score 0-100', source_tool: 'get_hub_risk', source_field: 'priority', family: null },
      { hub_id: 'denver', label: 'old answer', value: 3, unit: 'days', source_tool: 'get_hub_risk' }, // saved before the field existed
    ]
    const { unmount } = render(
      <DebugProvider debug>
        <FiguresTable figures={figs} verified />
      </DebugProvider>,
    )
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    expect(within(rows[0]).getAllByRole('cell')[3]).toHaveTextContent('get_hub_riskfamilies.winter.days_per_year')
    expect(within(rows[1]).getAllByRole('cell')[3]).toHaveTextContent(/^get_hub_riskpriority$/)
    expect(within(rows[2]).getAllByRole('cell')[3]).toHaveTextContent(/^get_hub_risk$/)
    unmount()

    render(<FiguresTable figures={figs} verified />)
    expect(screen.queryByText('families.winter.days_per_year')).not.toBeInTheDocument()
    expect(screen.queryByText('get_hub_risk')).not.toBeInTheDocument()
  })

  it('renders nothing without figures', () => {
    const { container } = render(<FiguresTable figures={[]} verified />)
    expect(container).toBeEmptyDOMElement()
  })
})
