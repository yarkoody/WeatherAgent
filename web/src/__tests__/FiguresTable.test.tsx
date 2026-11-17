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

  it('renders nothing without figures', () => {
    const { container } = render(<FiguresTable figures={[]} verified />)
    expect(container).toBeEmptyDOMElement()
  })
})
