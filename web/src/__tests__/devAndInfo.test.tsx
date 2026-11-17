// Developer view (?debug=1) versus the default analyst view, and the "How is this calculated?" buttons.
import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import { AnswerCard } from '../components/AnswerCard'
import { ToolSteps } from '../components/ai-elements/tool-steps'
import { DebugProvider, readDebugFlag } from '../lib/debug'
import { familyLines, indexLine, priorityLines } from '../lib/explain'
import type { ChatResponse, HubScore } from '../lib/types'
import mock from '../mocks/chat-response.json'
import { HubBreakdown } from '../widgets/HubBreakdown'
import { toolOutput } from './fixtures'

const response = mock as ChatResponse
const failed: ChatResponse = { ...response, grounding: { status: 'failed', errors: ['43 is not in figures'] } }
const hub = toolOutput('chat-stream.sse', 'get_hub_risk') as HubScore

const asUser = (ui: ReactNode) => render(<DebugProvider debug={false}>{ui}</DebugProvider>)
const asDev = (ui: ReactNode) => render(<DebugProvider debug>{ui}</DebugProvider>)

const tool = {
  toolCallId: 't1',
  name: 'rank_hubs',
  state: 'output-available' as const,
  input: { score: 'priority', hazard: 'overall', top_n: 5 },
  output: { kind: 'priority' },
}

beforeEach(() => localStorage.clear())

describe('developer flag', () => {
  it('?debug=1 turns it on and persists, ?debug=0 turns it off, default is off', () => {
    expect(readDebugFlag('')).toBe(false)
    expect(readDebugFlag('?debug=1')).toBe(true)
    expect(readDebugFlag('')).toBe(true) // remembered
    expect(readDebugFlag('?debug=0')).toBe(false)
    expect(readDebugFlag('')).toBe(false)
  })
})

describe('analyst view (default)', () => {
  it('answer card shows label, hub, value and the badge, but no tool names or trace id', () => {
    asUser(<AnswerCard response={failed} />)
    expect(screen.queryByRole('table')).not.toBeInTheDocument() // folded by default
    fireEvent.click(screen.getByRole('button', { name: /Figures behind this answer/ }))
    const table = screen.getByRole('table')
    expect(within(table).queryByText('Source')).not.toBeInTheDocument()
    for (const f of response.answer.figures) expect(screen.queryByText(f.source_tool)).not.toBeInTheDocument()
    expect(screen.queryByText(/trace/i)).not.toBeInTheDocument()
    expect(screen.queryByText('43 is not in figures')).not.toBeInTheDocument()
    expect(screen.getByText('Unverified')).toBeInTheDocument()
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Minneapolis')
  })

  it('tool steps are plain language, without tool names or expandable arguments', () => {
    asUser(<ToolSteps tools={[tool]} thinking={false} streaming={false} />)
    expect(screen.getByText('Ranked hubs by investment priority')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByText('rank_hubs')).not.toBeInTheDocument()
  })
})

describe('developer view', () => {
  it('answer card shows source tools, trace id and grounding errors', () => {
    asDev(<AnswerCard response={failed} />)
    expect(screen.getByText('Source')).toBeInTheDocument()
    expect(screen.getAllByText(response.answer.figures[0].source_tool).length).toBeGreaterThan(0)
    expect(screen.getByText(/trace mock-tra/)).toBeInTheDocument()
    expect(screen.getByText('43 is not in figures')).toBeInTheDocument()
  })

  it('tool steps expand to the tool name and arguments', () => {
    asDev(<ToolSteps tools={[tool]} thinking={false} streaming={false} />)
    fireEvent.click(screen.getByRole('button', { name: /Ranked hubs by investment priority/ }))
    expect(screen.getByText('rank_hubs')).toBeInTheDocument()
    expect(screen.getByText('top_n')).toBeInTheDocument()
  })
})

describe('How is this calculated?', () => {
  it('family lines use only numbers from the tool output', () => {
    const lines = familyLines(hub.families.winter)
    const fema = hub.families.winter.signals[0]
    expect(lines[0]).toContain(`${fema.raw} ${fema.unit}`)
    expect(lines[0]).toContain(`${fema.normalized} days/yr`)
    expect(lines[0]).toContain(`× ${fema.weight}`)
    expect(lines[0]).toContain(`= ${fema.contribution} days/yr`)
    expect(lines.at(-1)).toContain(`${hub.families.winter.days_per_year} days/yr`)
    expect(indexLine(hub.band_thresholds)).toBe(
      `Index = days per year ÷ ${hub.band_thresholds.days_cap} × 100, capped at 100. Medium from ${hub.band_thresholds.medium_from_days} days a year, high from ${hub.band_thresholds.high_from_days}.`,
    )
    const missing = familyLines(hub.families.hurricane)[0]
    expect(missing).toMatch(/missing in NRI/)
    expect(priorityLines(hub)[1]).toContain(`÷ cap ${hub.priority_signals[1].cap}`)
  })

  it('the winter (i) button opens the calculation and is keyboard reachable', async () => {
    asUser(<HubBreakdown data={hub} />)
    const button = screen.getByRole('button', { name: 'How is the Winter band calculated?' })
    button.focus()
    expect(button).toHaveFocus()
    fireEvent.click(button)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('FEMA expects about 16.6 winter weather')
    expect(dialog).not.toHaveTextContent(`${hub.families.winter.signals[0].raw} events/year`)
    fireEvent.click(within(dialog).getByRole('button', { name: 'More detail' }))
    expect(dialog).toHaveTextContent(`${hub.families.winter.signals[0].raw} events/year`)
    // v2: a family is banded by its own days (medium from 2, high from 5), not by the overall index
    expect(dialog).toHaveTextContent(
      `medium from ${hub.band_thresholds.family_medium_from_days} days a year and high from ${hub.band_thresholds.family_high_from_days}`,
    )
  })
})
