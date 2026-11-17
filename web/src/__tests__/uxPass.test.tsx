// UX pass: plain-language tips, compact numbers, reduced motion, answer-first hierarchy.
import { fireEvent, render, renderHook, screen, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnswerCard } from '../components/AnswerCard'
import { AssistantMessage } from '../components/AssistantMessage'
import { InfoTip } from '../components/InfoTip'
import { DebugProvider } from '../lib/debug'
import { badYearSteps, familySteps, indexSteps, prioritySteps } from '../lib/explain'
import { compact, fmt, pct } from '../lib/format'
import { NoMotion, useCountUp, useReducedMotion } from '../lib/motion'
import type { ChatResponse, HubScore } from '../lib/types'
import mock from '../mocks/chat-response.json'
import { toolOutput } from './fixtures'

const hub = toolOutput('chat-stream.sse', 'get_hub_risk') as HubScore
const response = mock as ChatResponse

afterEach(() => vi.unstubAllGlobals())

describe('compact numbers (display only)', () => {
  it('shortens large numbers and keeps one decimal for days and scores', () => {
    expect(compact(472_000)).toBe('472K')
    expect(compact(2_600_000)).toBe('2.6M')
    expect(compact(1_200_000_000)).toBe('1.2B')
    expect(fmt(1_281_172)).toBe('1.28M')
    expect(fmt(21.32)).toBe('21.3')
    expect(fmt(85.3)).toBe('85.3')
  })

  it('formats percentages without needless decimals', () => {
    expect(pct(95.04)).toBe('95%')
    expect(pct(10.1)).toBe('10%')
    expect(pct(2.43)).toBe('2.4%')
    expect(pct(0)).toBe('0%')
  })
})

describe('plain-language tips', () => {
  it('explain a hazard family in at most five short steps, from tool data', () => {
    const steps = familySteps(hub.families.winter, hub.band_thresholds)
    expect(steps.length).toBeLessThanOrEqual(5)
    expect(steps[0]).toBe('FEMA expects about 16.6 winter weather, 0.5 ice storm and 8.9 cold wave events a year in this county.')
    expect(steps.join(' ')).toContain('60% FEMA, 40% observed')
    expect(steps.at(-1)).toContain(`about ${hub.families.winter.days_per_year} lost days a year`)
    expect(steps.join(' ')).not.toMatch(/×|normalized|contribution|_/)
  })

  it('explain the score and the bad year in one plain sentence each', () => {
    expect(indexSteps(hub.band_thresholds)[0]).toBe('Score = lost days ÷ 25 × 100. 25 days a year counts as the maximum.')
    expect(badYearSteps(hub)[0]).toBe(
      `In a bad year (about 1 year in 20) the hub could lose about ${hub.bad_year_days} days, because rare events like hurricanes are much worse than average.`,
    )
  })

  it('priority steps show people served in compact form', () => {
    expect(prioritySteps(hub).join(' ')).toContain('1.28M people')
  })

  it('InfoTip shows numbered steps and hides the technical detail until asked', async () => {
    render(<InfoTip subject="Winter band" steps={['First step.', 'Second step.']} detail={['signal × 0.6 = 4.974']} />)
    fireEvent.click(screen.getByRole('button', { name: 'How is the Winter band calculated?' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['First step.', 'Second step.'])
    expect(within(dialog).queryByText('signal × 0.6 = 4.974')).not.toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'More detail' }))
    expect(within(dialog).getByText('signal × 0.6 = 4.974')).toBeInTheDocument()
  })
})

describe('motion', () => {
  const media = (reduce: boolean) =>
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce && q.includes('reduce'), addEventListener() {}, removeEventListener() {} }))

  it('respects prefers-reduced-motion: numbers show their final value at once', () => {
    media(true)
    expect(renderHook(() => useReducedMotion()).result.current).toBe(true)
    expect(renderHook(() => useCountUp(26.3)).result.current).toBe(26.3)
  })

  it('counts up from zero when motion is allowed', () => {
    media(false)
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    expect(renderHook(() => useCountUp(26.3)).result.current).toBe(0)
  })
})

describe('restored history does not replay animations', () => {
  it('NoMotion turns motion off for everything inside it', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
    vi.stubGlobal('requestAnimationFrame', () => 0)
    vi.stubGlobal('cancelAnimationFrame', () => {})
    const { result } = renderHook(() => useCountUp(26.3), { wrapper: NoMotion })
    expect(result.current).toBe(26.3)
  })
})

describe('answer first, details collapsed', () => {
  const message: UIMessage = {
    id: 'a1',
    role: 'assistant',
    parts: [
      { type: 'tool-rank_hubs', toolCallId: 't1', state: 'output-available', input: { score: 'exposure', hazard: 'winter', region: 'Midwest' }, output: {} },
      { type: 'data-answer', data: response },
    ] as UIMessage['parts'],
  }

  it('analyst view folds the steps and the figures behind toggles', () => {
    render(
      <DebugProvider debug={false}>
        <AssistantMessage message={message} streaming={false} />
      </DebugProvider>,
    )
    expect(screen.getByRole('button', { name: /How this answer was found \(1 step\)/ })).toBeInTheDocument()
    expect(screen.queryByText('Ranked hubs by winter exposure in the Midwest')).not.toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(`Numbers behind this answer (${response.answer.figures.length})`))
    expect(screen.getByRole('table')).toBeInTheDocument()
  })

  it('developer view keeps everything open', () => {
    render(
      <DebugProvider debug>
        <AnswerCard response={response} />
      </DebugProvider>,
    )
    expect(screen.getByRole('table')).toBeInTheDocument()
  })
})
