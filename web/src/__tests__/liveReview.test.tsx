// Fixes from the live-app screen-recording review: cut-off turns, no JEV, the scores primer, answers that
// use their charts, ranking totals and colors, follow-up filtering, the scroll button, and the hub map.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnswerCard } from '../components/AnswerCard'
import { AssistantMessage, answerUses, normalizeQuestion } from '../components/AssistantMessage'
import type { ToolPartView } from '../components/ai-elements/tool-steps'
import { HOWTO_KEY, HowScoresWork, topHubLine } from '../components/HowScoresWork'
import { RING_MILES, ringRadius, zoomFilter } from '../components/HubMap'
import { ScoresView } from '../components/ScoresView'
import { DebugProvider } from '../lib/debug'
import { LOST_DAYS, bandGapLine } from '../lib/explain'
import { FAMILY_LABEL, fmt, shortHubName } from '../lib/format'
import type { ChatResponse, Hub, HubComparison, HubScore, Ranking, ScoreRow } from '../lib/types'
import hubScoresJson from '../mocks/hub-scores.json'
import hubsJson from '../mocks/hubs.json'
import scoresJson from '../mocks/scores.json'
import { ComparisonCards, exposureAbovePriority } from '../widgets/ComparisonCards'
import { HubBreakdown } from '../widgets/HubBreakdown'
import { RankingWidget, coverage } from '../widgets/RankingWidget'
import { sseEvents, toolOutput } from './fixtures'

const scores = scoresJson as ScoreRow[]
const hubs = hubsJson as Hub[]
const hubScores = hubScoresJson as unknown as Record<string, HubScore>
const answerOf = (file: string) => sseEvents(file).find((e) => e.type === 'data-answer')!.data as ChatResponse
const hubRisk = toolOutput('chat-stream.sse', 'get_hub_risk') as HubScore
const ranking = toolOutput('chat-stream.sse', 'rank_hubs') as Ranking

function toolPart(name: string, output: unknown, id = 't1') {
  return { type: `tool-${name}`, toolCallId: id, state: 'output-available', input: {}, output }
}
function message(parts: unknown[]): UIMessage {
  return { id: 'a1', role: 'assistant', parts: parts as UIMessage['parts'] }
}

beforeEach(() => localStorage.clear())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('a cut-off turn shows one message', () => {
  it('tool results but no answer: "cut off" with Try again, and no "No answer received"', () => {
    const retry = vi.fn()
    render(<AssistantMessage message={message([toolPart('get_hub_risk', hubRisk)])} streaming={false} onRetry={retry} errored />)
    expect(screen.getByText('The answer was cut off. The results above are complete; try again for the explanation.')).toBeInTheDocument()
    expect(screen.queryByText(/No answer received/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retry).toHaveBeenCalled()
  })

  it('nothing arrived and the request failed: the turn stays empty (the network banner speaks for it)', () => {
    render(<AssistantMessage message={message([])} streaming={false} errored />)
    expect(screen.queryByText(/No answer received|cut off/)).not.toBeInTheDocument()
  })

  it('stopped before anything arrived, no error: "No answer received"', () => {
    render(<AssistantMessage message={message([])} streaming={false} />)
    expect(screen.getByText(/No answer received/)).toBeInTheDocument()
  })
})

describe('answers without figures, and charts the answer does not use', () => {
  it('no figures: no "Figures checked" badge; a failed check still shows', () => {
    const nodata = answerOf('chat-stream-nodata.sse')
    const { unmount } = render(<AnswerCard response={nodata} />)
    expect(screen.queryByText('Figures checked')).not.toBeInTheDocument()
    unmount()
    render(<AnswerCard response={answerOf('chat-stream-failed.sse')} />)
    expect(screen.getByText('Unverified')).toBeInTheDocument()
  })

  it('a hub widget only for a hub in answer.hubs; nothing under "no data" or a refusal; rankings when in scope with data', () => {
    const base = answerOf('chat-stream.sse') // hubs: minneapolis, chicago, detroit
    const part = (name: string, output: unknown) => ({ toolCallId: 't', name, state: 'output-available', input: {}, output }) as ToolPartView
    expect(answerUses(base, part('get_hub_risk', hubRisk))).toBe(true) // minneapolis
    expect(answerUses(base, part('get_hub_risk', hubScores.houston))).toBe(false)
    expect(answerUses(base, part('rank_hubs', ranking))).toBe(true)
    const nodata = { ...base, answer: { ...base.answer, data_available: false } }
    expect(answerUses(nodata, part('get_hub_risk', hubRisk))).toBe(false)
    expect(answerUses(nodata, part('rank_hubs', ranking))).toBe(false)
    const refusal = { ...base, answer: { ...base.answer, in_scope: false } }
    expect(answerUses(refusal, part('rank_hubs', ranking))).toBe(false)
  })

  it('the rendered message drops the unrelated hub chart', async () => {
    const response = answerOf('chat-stream-weather.sse') // about Denver
    render(<AssistantMessage message={message([toolPart('get_hub_risk', hubScores.houston), { type: 'data-answer', data: response }])} streaming={false} />)
    await act(async () => {})
    expect(screen.queryByRole('region', { name: /Houston risk breakdown/ })).not.toBeInTheDocument()
  })
})

describe('"Ask next" follow-ups', () => {
  it('come from the backend and never repeat a question already asked in this chat', () => {
    const response = answerOf('chat-stream-nodata.sse')
    const asked = new Set([normalizeQuestion(response.follow_ups![0].toUpperCase() + '  ')])
    render(<AssistantMessage message={message([{ type: 'data-answer', data: response }])} streaming={false} latest onFollowUp={() => {}} asked={asked} />)
    const chips = within(screen.getByRole('group', { name: 'Ask next' })).getAllByRole('button').map((b) => b.textContent)
    expect(chips).toEqual(response.follow_ups!.slice(1))
  })
})

describe('ranking widget', () => {
  it('says "Top N of M hubs" from Ranking.total, and hides it when total is 0 or missing', () => {
    const { unmount } = render(<RankingWidget data={{ ...ranking, total: 6 }} />)
    expect(screen.getByText(`Top ${ranking.items.length} of 6 hubs.`)).toBeInTheDocument()
    unmount()
    render(<RankingWidget data={{ ...ranking, total: 0 }} />)
    expect(screen.queryByText(/^Top \d+ of/)).not.toBeInTheDocument()
  })

  it('says "All N hubs" (with the region) when the ranking covers every matching hub', () => {
    expect(coverage(15, 15, null)).toBe('All 15 hubs.')
    expect(coverage(6, 6, 'Midwest')).toBe('All 6 Midwest hubs.')
    expect(coverage(5, 15, null)).toBe('Top 5 of 15 hubs.')
    render(<RankingWidget data={{ ...ranking, total: ranking.items.length }} />)
    expect(screen.getByText(`All ${ranking.items.length} ${ranking.region ? `${ranking.region} ` : ''}hubs.`)).toBeInTheDocument()
    expect(screen.queryByText(/^Top \d+ of/)).not.toBeInTheDocument()
  })

  it('the loading card shows only placeholder lines (the step row names the phase) and has no accent strip', async () => {
    const { PendingAnswer, CARD_SHELL } = await import('../components/AnswerCard')
    render(<PendingAnswer />)
    const card = screen.getByRole('status', { name: 'Answer loading' })
    expect(card).not.toHaveTextContent(/Validating/)
    expect(card.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0)
    expect(card.querySelector('.absolute.top-0')).toBeNull()
    expect(card.className).toBe(CARD_SHELL) // identical shell to the finished answer card
  })

  it('explains in one plain line why exposure and priority bands can differ', () => {
    expect(bandGapLine({ exposure_band: 'high', priority_band: 'medium' }, 'Denver')).toBe(
      'Denver is High exposure but Medium priority: priority also weighs the people served and how resilient the county is, not only the weather.',
    )
    expect(bandGapLine({ exposure_band: 'high', priority_band: 'high' })).toBeNull()
  })
})

describe('Scores page', () => {
  function serve() {
    vi.stubEnv('VITE_USE_MOCKS', '')
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const path = new URL(url, 'http://test').pathname
        calls.push(path)
        if (path === '/scores') return Response.json(scores)
        if (path === '/hubs') return Response.json(hubs)
        const m = /^\/hubs\/([a-z_]+)\/score$/.exec(path)
        if (m) return Response.json(hubScores[m[1]])
        return Response.json({ detail: 'not found' }, { status: 404 })
      }),
    )
    return calls
  }
  const view = async () => {
    render(
      <DebugProvider debug={false}>
        <ScoresView />
      </DebugProvider>,
    )
    await screen.findAllByRole('rowheader')
  }

  it('"How the scores work" is open the first time, remembers being closed, and names the top hub from live data', async () => {
    const { unmount } = render(<HowScoresWork rows={scores} />)
    const toggle = screen.getByRole('button', { name: 'How the scores work' })
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    const top = topHubLine(scores)!
    const leader = [...scores].sort((a, b) => b.exposure_days_per_year - a.exposure_days_per_year)[0]
    expect(top.question).toBe(`Why is ${shortHubName(leader.name)} #1 for lost operating days?`)
    expect(top.answer).toContain(FAMILY_LABEL[leader.top_driver].toLowerCase())
    expect(screen.getByTestId('howto-example')).toHaveTextContent(top.question)
    for (const p of screen.getByTestId('howto-example').parentElement!.querySelectorAll('p')) expect(p.textContent!.length).toBeLessThan(300)
    fireEvent.click(toggle)
    expect(localStorage.getItem(HOWTO_KEY)).toBe('closed')
    unmount()
    render(<HowScoresWork rows={scores} />)
    expect(screen.getByRole('button', { name: 'How the scores work' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('the primer reserves its example line while scores load (no shift above the table)', () => {
    render(<HowScoresWork rows={null} />)
    expect(screen.getByTestId('howto-example')).toBeEmptyDOMElement()
    expect(screen.getByTestId('howto-example').className).toContain('min-h-')
  })

  it('map: one focusable dot per hub; Enter highlights its row and opens the breakdown from /hubs/{id}/score', async () => {
    const calls = serve()
    await view()
    const map = await screen.findByRole('region', { name: 'Hub map' }, { timeout: 3000 })
    const dots = within(map).getAllByRole('button', { name: /biggest risk/ })
    expect(dots).toHaveLength(hubs.length)
    const miami = within(map).getByRole('button', { name: /^Miami: biggest risk/ })
    expect(miami).toHaveAttribute('tabindex', '0')
    fireEvent.keyDown(miami, { key: 'Enter' })
    expect(miami).toHaveAttribute('aria-pressed', 'true')
    expect(document.getElementById('hub-row-miami')).toHaveAttribute('data-selected', 'true')
    expect(await screen.findByRole('region', { name: 'Miami risk breakdown' })).toBeInTheDocument()
    expect(calls).toContain('/hubs/miami/score')
    fireEvent.click(screen.getByRole('button', { name: 'Close hub breakdown' }))
    expect(screen.queryByRole('region', { name: 'Miami risk breakdown' })).not.toBeInTheDocument()
  })

  it('map: rings in map units, zoom buttons and reset, and Ctrl/⌘ for wheel zoom', async () => {
    serve()
    await view()
    const map = await screen.findByRole('region', { name: 'Hub map' }, { timeout: 3000 })
    expect(map.querySelectorAll('[data-ring]')).toHaveLength(hubs.length)
    expect(within(map).getByText('Ring: area whose local floods, tornadoes, wind and hail count toward the hub.')).toBeInTheDocument()
    const zoomIn = within(map).getByRole('button', { name: 'Zoom in' })
    const out = within(map).getByRole('button', { name: 'Zoom out' })
    expect(out).toBeDisabled()
    fireEvent.click(zoomIn)
    await waitFor(() => expect(out).not.toBeDisabled())
    fireEvent.click(within(map).getByRole('button', { name: 'Reset map' }))
    await waitFor(() => expect(out).toBeDisabled())
    expect(zoomFilter(new WheelEvent('wheel'))).toBe(false)
    expect(zoomFilter(new WheelEvent('wheel', { ctrlKey: true }))).toBe(true)
    expect(zoomFilter(new MouseEvent('mousedown'))).toBe(true)
  })

  it('ring radius is the 1,000 sq mi circle (about 17.8 miles), scaled by the projection', () => {
    expect(RING_MILES).toBeCloseTo(17.84, 2)
    // A flat projection at 10 px per degree of latitude: 17.84 mi / 69.05 mi per degree = 0.2584° = 2.58 px.
    const flat = ([lon, lat]: [number, number]) => [lon * 10, -lat * 10] as [number, number]
    expect(ringRadius(flat, -90, 30)).toBeCloseTo((RING_MILES / 69.05) * 10, 5)
    const twice = ([lon, lat]: [number, number]) => [lon * 20, -lat * 20] as [number, number]
    expect(ringRadius(twice, -90, 30)).toBeCloseTo(2 * ringRadius(flat, -90, 30), 5)
  })
})

describe('chat layout', () => {
  it('the scroll-to-end button sits bottom right and the thread keeps room below the "Ask next" chips', async () => {
    const { ChatView } = await import('../components/ChatView')
    const { saveChatMessages } = await import('../lib/chats')
    const events = sseEvents('chat-stream.sse')
    saveChatMessages('c1', [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Rank Midwest hubs by winter exposure' }] },
      message([{ type: 'data-answer', data: events.find((e) => e.type === 'data-answer')!.data }]),
    ])
    render(<ChatView sessionId="c1" />)
    const button = screen.getByTestId('scroll-to-end')
    expect(button.className).toContain('end-4')
    expect(button.className).toContain('inset-s-auto')
    expect(document.querySelector('[aria-busy]')!.className).toContain('pb-20')
  })
})

describe('comparison table (approved design)', () => {
  const cmp = toolOutput('chat-stream-compare.sse', 'compare_hubs') as HubComparison
  const ROWS = [
    'Typical year (days/yr)',
    'Bad year (days/yr)',
    'Exposure score (0-100)',
    'Exposure level',
    'Screening priority (0-100)',
    'Priority level',
    'Biggest risk',
  ]

  it('fixed rows in order, one column per hub, the same number of cells in every row', () => {
    render(<ComparisonCards data={{ ...cmp, hazards: ['overall'] }} />)
    expect(screen.getByRole('heading')).toHaveTextContent(`Comparing ${cmp.hubs.length} hubs`)
    expect(screen.getByText(/Lost operating days a year from weather \(modeled estimate\)\. Highest in each row is highlighted\. Data as of/)).toBeInTheDocument()
    const table = screen.getByRole('table')
    expect(table.className).toContain('table-fixed')
    expect(within(table).getAllByRole('rowheader').map((th) => th.textContent)).toEqual(ROWS)
    const heads = within(table).getAllByRole('columnheader')
    expect(heads).toHaveLength(cmp.hubs.length + 1)
    for (const h of heads.slice(1)) expect(h.className).toContain('text-right')
    for (const tr of within(table).getAllByRole('row')) expect(tr.children).toHaveLength(cmp.hubs.length + 1)
  })

  it('numbers are right-aligned tabular digits, units only in the row labels', () => {
    render(<ComparisonCards data={cmp} />)
    for (const td of document.querySelectorAll('td[data-kind="number"]')) {
      expect(td.className).toContain('text-right')
      expect(td.className).toContain('tabular-nums')
      expect(td.textContent).toMatch(/^(\d+(\.\d)?|n\/a)$/) // no "d/yr" after numbers
    }
  })

  it('highlights the highest value in each numeric row, and nothing when all are equal', () => {
    render(<ComparisonCards data={cmp} />)
    const row = screen.getByRole('rowheader', { name: 'Typical year (days/yr)' }).closest('tr')!
    const max = Math.max(...cmp.hubs.map((h) => h.exposure_days_per_year))
    const marked = row.querySelectorAll('[data-max]')
    expect(marked).toHaveLength(1)
    expect(marked[0].textContent).toBe(fmt(max))
    cleanup()
    const same = { ...cmp, hubs: cmp.hubs.map((h) => ({ ...h, priority: 50 })) }
    render(<ComparisonCards data={same} />)
    expect(screen.getByRole('rowheader', { name: 'Screening priority (0-100)' }).closest('tr')!.querySelectorAll('[data-max]')).toHaveLength(0)
  })

  it('asked hazards get their own rows after the fixed ones', () => {
    render(<ComparisonCards data={{ ...cmp, hazards: ['flood', 'hurricane'] }} />)
    const labels = screen.getAllByRole('rowheader').map((th) => th.textContent)
    expect(labels.slice(0, 7)).toEqual(ROWS)
    expect(labels.slice(7)).toEqual(['Flood (days/yr)', 'Hurricane, 10-yr chance (%)'])
  })

  it('the "High exposure but Medium priority" footer only when such a hub is present', () => {
    const hubsWith = (e: 'high' | 'medium', p: 'high' | 'medium') => ({ ...cmp, hubs: cmp.hubs.map((h) => ({ ...h, exposure_band: e, priority_band: p })) })
    render(<ComparisonCards data={hubsWith('high', 'medium')} />)
    expect(screen.getByTestId('compare-footer')).toHaveTextContent(
      'Why can a hub be High exposure but Medium priority? Priority also weighs people served and how well the area recovers.',
    )
    cleanup()
    render(<ComparisonCards data={hubsWith('medium', 'medium')} />)
    expect(screen.queryByTestId('compare-footer')).not.toBeInTheDocument()
    expect(exposureAbovePriority({ exposure_band: 'high', priority_band: 'medium' })).toBe(true)
    expect(exposureAbovePriority({ exposure_band: 'medium', priority_band: 'high' })).toBe(false)
  })

  it('narrow screens: the same table scrolls sideways with the label column pinned', () => {
    render(<ComparisonCards data={cmp} />)
    expect(screen.getByTestId('compare-scroll').className).toContain('overflow-x-auto')
    for (const th of screen.getAllByRole('rowheader')) expect(th.className).toContain('sticky')
    expect(screen.getByRole('table').style.minWidth).toMatch(/rem/) // a floor per hub column, so cells never squeeze
  })
})

describe('plain words', () => {
  it('"How to read this" defines lost operating days first and explains the bad year once', async () => {
    render(<ComparisonCards data={toolOutput('chat-stream-compare.sse', 'compare_hubs') as HubComparison} />)
    fireEvent.click(screen.getByRole('button', { name: 'How to read this' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('term').map((t) => t.textContent)[0]).toMatch(/^Lost operating days/)
    expect(dialog).toHaveTextContent(LOST_DAYS)
    expect(dialog).toHaveTextContent('Bad year: the average of the worst 1 year in 20.')
    expect(dialog).not.toHaveTextContent('(1 in 20)')
  })

  it('no "Top driver", "(1 in 20)" or "band" in labels on the Scores page or the breakdown', async () => {
    render(<HubBreakdown data={hubRisk} />)
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/Top driver|\(1 in 20\)/)
    expect(text).toContain('Biggest risk')
    cleanup()
    render(<HowScoresWork rows={scores} />)
    expect(document.body.textContent).toContain(`Lost operating days are ${LOST_DAYS}`)
  })
})
