// What-if sliders, observed history widgets, and analyst export (CSV + print report).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnswerCard } from '../components/AnswerCard'
import { AssistantMessage } from '../components/AssistantMessage'
import { ScoresView } from '../components/ScoresView'
import { AskProvider } from '../lib/ask'
import { DebugProvider } from '../lib/debug'
import { toCsv } from '../lib/exportCsv'
import type { ChatResponse, HubHistory, HubScore, ScoreRow, WhatIfResult } from '../lib/types'
import { WEIGHT_STEPS } from '../components/WhatIfPanel'
import historyJson from '../mocks/history-minneapolis.json'
import scoresJson from '../mocks/scores.json'
import whatIfJson from '../mocks/what-if.json'
import { HistoryWidget } from '../widgets/HistoryWidget'
import { HubBreakdown } from '../widgets/HubBreakdown'
import { sseEvents, toolOutput } from './fixtures'

const scores = scoresJson as ScoreRow[]
const example = whatIfJson.example as WhatIfResult
const history = historyJson as HubHistory
const hub = toolOutput('chat-stream.sse', 'get_hub_risk') as HubScore
const answer = sseEvents('chat-stream.sse').find((e) => e.type === 'data-answer')!.data as ChatResponse

function serve() {
  const posts: unknown[] = []
  vi.stubEnv('VITE_USE_MOCKS', '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://test').pathname
      if (path === '/scores') return Response.json(scores)
      if (path === '/what-if') {
        posts.push(JSON.parse(String(init?.body)))
        return Response.json(example)
      }
      return Response.json({ detail: 'not found' }, { status: 404 })
    }),
  )
  return posts
}
const scoresView = async () => {
  render(
    <DebugProvider debug={false}>
      <ScoresView />
    </DebugProvider>,
  )
  await screen.findAllByRole('rowheader')
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('what-if panel', () => {
  it('re-ranks with analyst weights (debounced), shows rank changes, per-$1M with costs, and resets', async () => {
    const posts = serve()
    await scoresView()
    fireEvent.click(screen.getByRole('button', { name: 'What if' }))
    const panel = screen.getByRole('region', { name: 'What if' })
    expect(within(panel).getByText('Analyst-supplied weights and costs. Scores themselves do not change.')).toBeInTheDocument()
    expect(posts).toHaveLength(0) // defaults: nothing to recompute

    const hurricane = within(panel).getByRole('slider', { name: 'Hurricane weight' })
    fireEvent.change(hurricane, { target: { value: String(WEIGHT_STEPS.indexOf(3)) } })
    fireEvent.change(hurricane, { target: { value: String(WEIGHT_STEPS.indexOf(3)) } })
    await waitFor(() => expect(posts).toHaveLength(1), { timeout: 1500 }) // debounced: one request
    expect(posts[0]).toMatchObject({ family_weights: { hurricane: 3 } })

    const list = await within(panel).findByRole('list', { name: 'What-if priority ranking' })
    const first = within(list).getAllByRole('listitem')[0]
    expect(first).toHaveTextContent(example.ranking[0].name.replace(/ Hub$/, ''))
    const baselineRank = [...scores].sort((a, b) => b.priority - a.priority || a.hub_id.localeCompare(b.hub_id)).findIndex((r) => r.hub_id === example.ranking[0].hub_id) + 1
    const moved = baselineRank - 1
    if (moved > 0) expect(within(first).getByLabelText(`Up ${moved}`)).toBeInTheDocument()

    fireEvent.change(within(panel).getByLabelText('Upgrade cost for Miami ($M)'), { target: { value: '12' } })
    await waitFor(() => expect(posts.at(-1)).toMatchObject({ upgrade_costs: [{ hub_id: 'miami', cost_musd: 12 }] }), { timeout: 1500 })
    expect(await within(panel).findByRole('list', { name: 'Priority per $1M' })).toBeInTheDocument()

    fireEvent.click(within(panel).getByRole('button', { name: 'Reset' }))
    expect(within(panel).getByRole('slider', { name: 'Hurricane weight' })).toHaveValue(String(WEIGHT_STEPS.indexOf(1)))
    expect(within(panel).queryByRole('list', { name: 'Priority per $1M' })).not.toBeInTheDocument()
  })
})

describe('history widgets', () => {
  it('draws yearly stacked bars with the worst year, and a seasonal heatmap with peak months', async () => {
    render(<HistoryWidget data={history} />)
    const worst = history.years.find((y) => y.year === history.worst_year)!
    expect(screen.getByText(`Worst year: ${history.worst_year} (${worst.total} days)`)).toBeInTheDocument()
    const heat = screen.getByRole('table', { name: /Average disruption-threshold days by month/ })
    const jan = within(heat).getByRole('cell', { name: /Winter, Jan:/ })
    expect(jan).toBeInTheDocument()
    for (const m of history.peak_months) {
      const header = within(heat).getAllByRole('columnheader')[m] // first header is the row label column
      expect(header).toHaveAttribute('data-peak', 'true')
    }
    fireEvent.click(screen.getByRole('button', { name: /How is the observed history calculated/ }))
    const tip = await screen.findByRole('dialog')
    expect(tip).toHaveTextContent(history.thresholds.winter)
    expect(tip).toHaveTextContent(history.note.slice(0, 40))
  })

  it('the breakdown has a History tab: uses history the agent fetched, otherwise GET /hubs/{id}/history', async () => {
    const ask = vi.fn()
    const { unmount } = render(
      <AskProvider ask={ask} histories={{ [hub.hub_id]: history }}>
        <HubBreakdown data={hub} />
      </AskProvider>,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(screen.getByText(`Worst year: ${history.worst_year}`, { exact: false })).toBeInTheDocument()
    unmount()

    vi.stubEnv('VITE_USE_MOCKS', '')
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url, 'http://test').pathname
        calls.push(path)
        if (path === `/hubs/${hub.hub_id}/history`) return Response.json(history)
        return Response.json({ detail: 'Unknown hub' }, { status: 404 })
      }),
    )
    const { unmount: unmount2 } = render(<HubBreakdown data={hub} />)
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(screen.getByRole('status', { name: /Loading the observed history/ })).toBeInTheDocument()
    expect(await screen.findByText(`Worst year: ${history.worst_year}`, { exact: false })).toBeInTheDocument()
    expect(calls).toContain(`/hubs/${hub.hub_id}/history`)
    expect(screen.queryByText(/Ask in chat/)).not.toBeInTheDocument()
    expect(ask).not.toHaveBeenCalled()
    unmount2()

    render(<HubBreakdown data={{ ...hub, hub_id: 'nowhere' }} />)
    fireEvent.click(screen.getByRole('tab', { name: 'History' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded (Unknown hub)')
  })

  it('renders from a get_hub_history tool part in a message', async () => {
    const events = sseEvents('chat-stream-history.sse')
    const output = events.find((e) => e.type === 'tool-output-available')!
    const message: UIMessage = {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: 'tool-get_hub_history', toolCallId: 't1', state: 'output-available', input: { hub_id: 'minneapolis' }, output: output.output },
        { type: 'data-answer', data: events.find((e) => e.type === 'data-answer')!.data },
      ] as UIMessage['parts'],
    }
    render(<AssistantMessage message={message} streaming={false} />)
    expect(await screen.findByRole('region', { name: 'Minneapolis observed history' })).toBeInTheDocument()
  })
})

describe('export', () => {
  it('CSV escapes and keeps the table order', () => {
    expect(toCsv([['Hub', 'Note'], ['Kansas City', 'a, "b"']])).toBe('Hub,Note\r\nKansas City,"a, ""b"""\r\n')
  })

  it('Export CSV downloads the current Scores view (filters and sort)', async () => {
    serve()
    let blob: Blob | null = null
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (b: Blob) => ((blob = b), 'blob:x'), revokeObjectURL: () => {} }))
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    await scoresView()
    fireEvent.change(screen.getByLabelText('Region'), { target: { value: 'South' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sort by Hub' }))
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }))
    expect(click).toHaveBeenCalled()
    const text = await blob!.text()
    const lines = text.trim().split('\r\n')
    expect(lines[0]).toBe('Rank,Hub,Region,Typical year (days/yr),Bad year (days/yr),"Hurricane chance (10 yr, %)","Review priority (0-100, typical year)",Priority level,Exposure level,"People served (metro, estimate)",People-days typical year (M/yr),People-days bad year (M/yr),Biggest risk')
    const south = scores.filter((r) => r.region === 'South').map((r) => r.name.replace(/ Hub$/, '')).sort((a, b) => a.localeCompare(b))
    expect(lines.slice(1).map((l) => l.split(',')[1])).toEqual(south)
    click.mockRestore()
  })

  it('Export report opens a print view of the answer and calls print', () => {
    const print = vi.fn()
    vi.stubGlobal('print', print)
    render(<AnswerCard response={answer} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }))
    const report = screen.getByRole('document', { name: 'Printable report' })
    expect(report).toHaveTextContent('Minneapolis')
    expect(within(report).getByRole('table')).toBeInTheDocument() // figures
    expect(report).toHaveTextContent('Figures checked')
    expect(report).toHaveTextContent(answer.answer.uncertainty)
    expect(report).toHaveTextContent(window.location.origin)
    expect(print).toHaveBeenCalled()
    act(() => window.dispatchEvent(new Event('afterprint')))
    expect(screen.queryByRole('document', { name: 'Printable report' })).not.toBeInTheDocument()
  })

  it('the hub breakdown exports a report too', () => {
    vi.stubGlobal('print', vi.fn())
    render(<HubBreakdown data={hub} />)
    fireEvent.click(screen.getByRole('button', { name: 'Export report' }))
    const report = screen.getByRole('document', { name: 'Printable report' })
    expect(report).toHaveTextContent('Minneapolis risk breakdown')
    expect(report).toHaveTextContent(`${hub.exposure_days_per_year}`)
    expect(report).toHaveTextContent('Data as of Nov 17, 2026')
  })
})
