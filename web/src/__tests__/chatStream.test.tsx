import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { pickScenario } from '../lib/mockFetch'
import { toolLabel } from '../lib/toolLabels'

vi.stubEnv('VITE_USE_MOCKS', '1')

describe('mock transport', () => {
  it('picks a recorded scenario per question', () => {
    expect(pickScenario('Which Midwest hubs are most exposed to winter weather?')).toBe('ranking')
    expect(pickScenario('Compare Houston and Dallas on flood risk.')).toBe('compare')
    expect(pickScenario('What percentage of days did it snow in Denver in 2025?')).toBe('weather')
    expect(pickScenario('Are there any active weather alerts for Houston?')).toBe('alerts')
    expect(pickScenario('How many snow days did Denver have in 2026?')).toBe('nodata')
    expect(pickScenario('Give me a banana bread recipe')).toBe('outofscope')
    expect(pickScenario('How exposed is Houston?')).toBe('failed')
  })

  it('writes progress chips in plain language', () => {
    expect(toolLabel('get_hub_risk', { hub_id: 'dallas' }, false)).toBe('Checking Dallas risk')
    expect(toolLabel('rank_hubs', { score: 'exposure', hazard: 'winter', region: 'Midwest' }, true)).toBe(
      'Ranked hubs by winter exposure in the Midwest',
    )
    expect(toolLabel('compare_hubs', { hub_ids: ['houston', 'kansas_city'] }, false)).toBe('Comparing Houston and Kansas City')
  })
})

describe('chat over the recorded stream (real AI SDK parser)', () => {
  it('renders progress chips, one answer card and the widgets', async () => {
    const { ChatView } = await import('../components/ChatView')
    render(<ChatView sessionId="test-session" />)
    const button = screen.getByRole('button', { name: /Midwest hubs/ })
    fireEvent.click(button)

    await waitFor(() => expect(screen.getByLabelText('Answer')).toBeInTheDocument(), { timeout: 8000 })
    // the steps fold into one line once the answer is in
    fireEvent.click(screen.getByRole('button', { name: /Analysis steps \(2\)/ }))
    expect(screen.getByText('Ranked hubs by winter exposure in the Midwest')).toBeInTheDocument()
    expect(screen.getByText('Checked Minneapolis risk')).toBeInTheDocument()
    expect(screen.getAllByLabelText('Answer')).toHaveLength(1)
    expect(screen.getByText('Figures checked')).toBeInTheDocument()
    expect(await screen.findByLabelText('Ranking chart')).toBeInTheDocument()
    expect(await screen.findByLabelText('Minneapolis risk breakdown')).toBeInTheDocument()
  }, 10000)
})
