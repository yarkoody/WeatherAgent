// Every widget rendered from REAL tool outputs (captured from app.tools.run_tool against the committed snapshot),
// not hand-shaped mocks: mocks alone missed a crash on real get_hub_risk data. Regenerate with
// `PYTHONPATH=. uv run python <scratchpad>/real_outputs.py web/src/__tests__/real/tool-outputs.json` from the repo root.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import type { ComponentType } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AssistantMessage } from '../components/AssistantMessage'
import { ScoresView } from '../components/ScoresView'
import { DebugProvider } from '../lib/debug'
import * as explain from '../lib/explain'
import { FAMILIES } from '../lib/format'
import { normalizeHub } from '../lib/normalize'
import type { HubScore, ScoreRow, ToolName, WhatIfResult } from '../lib/types'
import scoresJson from '../mocks/scores.json'
import { AlertBanner } from '../widgets/AlertBanner'
import { ComparisonCards } from '../widgets/ComparisonCards'
import { HistoryWidget } from '../widgets/HistoryWidget'
import { HubBreakdown } from '../widgets/HubBreakdown'
import { RankingWidget } from '../widgets/RankingWidget'
import { WeatherStatRing } from '../widgets/WeatherStatRing'
import real from './real/tool-outputs.json'

interface Case {
  tool: ToolName
  input: Record<string, unknown>
  output: Record<string, unknown>
}
const cases = real as unknown as Case[]
const ok = (c: Case) => !('error' in c.output) && !('__exception__' in c.output)
const of = (tool: ToolName) => cases.filter((c) => c.tool === tool && ok(c))
const label = (c: Case) => `${c.tool} ${JSON.stringify(c.input)}`

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DIRECT: Partial<Record<ToolName, ComponentType<{ data: any }>>> = {
  get_hub_risk: HubBreakdown,
  rank_hubs: RankingWidget,
  compare_hubs: ComparisonCards,
  weather_stat: WeatherStatRing,
  get_active_alerts: AlertBanner,
  get_hub_history: HistoryWidget,
}

/** Opens every (i) tip, tab and disclosure inside the widget, so every explanation path is formatted. */
async function exerciseAll(root: HTMLElement) {
  for (const tab of within(root).queryAllByRole('tab')) fireEvent.click(tab)
  for (const tab of within(root).queryAllByRole('tab')) {
    fireEvent.click(tab)
    for (const b of within(root).queryAllByRole('button', { name: /How is|What is|calculated|explain/i })) {
      fireEvent.click(b)
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })
    }
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('real tool outputs: every widget renders without throwing', () => {
  it('covers every widget tool', () => {
    for (const tool of Object.keys(DIRECT) as ToolName[]) expect(of(tool).length, tool).toBeGreaterThan(0)
    expect(of('rank_hubs').map((c) => `${c.input.score}/${c.input.hazard}`)).toEqual(
      expect.arrayContaining(['exposure/overall', 'priority/overall', 'bad_year/overall', 'exposure/winter', 'exposure/hurricane']),
    )
    expect(of('get_hub_risk').map((c) => c.input.hub_id)).toEqual(expect.arrayContaining(['minneapolis', 'miami', 'phoenix', 'houston']))
  })

  for (const c of cases.filter((c) => c.tool in DIRECT && ok(c))) {
    it(`direct: ${label(c)}`, async () => {
      const Widget = DIRECT[c.tool]!
      const { container } = render(<Widget data={c.output} />)
      await exerciseAll(container)
      expect(container.textContent).not.toMatch(/undefined|NaN/)
    })
  }

  for (const c of cases.filter((c) => c.tool in DIRECT)) {
    it(`in a message (lazy widget + error boundary): ${label(c)}`, async () => {
      const message: UIMessage = {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: `tool-${c.tool}`, toolCallId: 't1', state: 'output-available', input: c.input, output: c.output }] as UIMessage['parts'],
      }
      render(<AssistantMessage message={message} streaming={false} />)
      if (ok(c)) await waitFor(() => expect(document.querySelector('[data-slot="skeleton"], [aria-busy="true"]')).toBeNull(), { timeout: 3000 })
      expect(screen.queryByText(/could not be drawn/i)).not.toBeInTheDocument()
    })
  }
})

/** Every "How is this calculated?" line and plain step the widgets can show for one hub. */
function allExplainLines(s: HubScore): string[] {
  const t = s.band_thresholds
  return [
    ...FAMILIES.flatMap((f) => (s.families[f] ? [...explain.familyLines(s.families[f]), ...explain.familySteps(s.families[f], t)] : [])),
    explain.indexLine(t),
    ...explain.exposureLines(s),
    ...explain.priorityLines(s),
    ...explain.badYearLines(s),
    explain.familyBandLine(t),
    ...explain.hurricaneLines(s),
    ...explain.indexSteps(t),
    ...explain.exposureSteps(s),
    ...explain.badYearSteps(s),
    ...explain.hurricaneSteps(s),
    ...explain.prioritySteps(s),
  ]
}

describe('real get_hub_risk: every explain() path formats real values', () => {
  for (const c of of('get_hub_risk')) {
    it(`${c.input.hub_id}`, () => {
      const lines = allExplainLines(c.output as unknown as HubScore)
      for (const l of lines) expect(l).not.toMatch(/undefined|NaN|null/)
    })
  }
})

describe('real what_if output on the Scores page', () => {
  for (const c of of('what_if')) {
    it(label(c), async () => {
      vi.stubEnv('VITE_USE_MOCKS', '')
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
          const path = new URL(url, 'http://test').pathname
          if (path === '/scores') return Response.json(scoresJson as ScoreRow[])
          if (path === '/what-if') return Response.json(c.output as unknown as WhatIfResult)
          return Response.json({ detail: 'not found' }, { status: 404 })
        }),
      )
      render(
        <DebugProvider debug={false}>
          <ScoresView />
        </DebugProvider>,
      )
      await screen.findAllByRole('rowheader')
      fireEvent.click(screen.getByRole('button', { name: 'What if' }))
      const panel = screen.getByRole('region', { name: 'What if' })
      fireEvent.change(within(panel).getByRole('slider', { name: 'Hurricane weight' }), { target: { value: '10' } })
      expect(await within(panel).findByRole('list', { name: 'What-if priority ranking' }, { timeout: 2000 })).toBeInTheDocument()
      expect(panel.textContent).not.toMatch(/undefined|NaN/)
      vi.unstubAllEnvs()
    })
  }
})

/** Every field path of an object, for dropping or nulling one field at a time. */
function paths(v: unknown, prefix: string[] = []): string[][] {
  if (v === null || typeof v !== 'object') return [prefix]
  const out: string[][] = prefix.length ? [prefix] : []
  const entries = Array.isArray(v) ? v.slice(0, 1).map((x, i) => [String(i), x] as const) : Object.entries(v)
  for (const [k, x] of entries) out.push(...paths(x, [...prefix, k]))
  return out
}
function mutate<T>(obj: T, path: string[], how: 'delete' | 'null'): T {
  const copy = structuredClone(obj) as Record<string, unknown>
  let cur = copy as Record<string, unknown>
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string, unknown>
  if (how === 'delete' && !Array.isArray(cur)) delete cur[path.at(-1)!]
  else cur[path.at(-1)!] = null
  return copy as T
}

describe('real get_hub_risk with any one field missing or null: no crash, no "undefined"/"NaN" text', () => {
  for (const hub of ['minneapolis', 'miami']) {
    const base = of('get_hub_risk').find((c) => c.input.hub_id === hub)!.output as unknown as HubScore
    const all = paths(base).filter((p) => p[0] !== 'hub_id') // without an id there is no hub to draw
    it(`${hub}: ${all.length} fields × (deleted, null)`, () => {
      const failures: string[] = []
      for (const p of all)
        for (const how of ['delete', 'null'] as const) {
          const data = mutate(base, p, how)
          try {
            // The widget, and every explanation it can open (the (i) tips render these same lines).
            const { container, unmount } = render(<HubBreakdown data={data} />)
            const bad = [container.textContent ?? '', ...allExplainLines(normalizeHub(data))].find((l) => /undefined|NaN/.test(l))
            if (bad) failures.push(`${how} ${p.join('.')}: shows "${bad.slice(0, 80)}"`)
            unmount()
          } catch (e) {
            failures.push(`${how} ${p.join('.')}: ${(e as Error).message.split('\n')[0]}`)
          }
        }
      expect(failures).toEqual([])
    }, 60_000)
  }
})
