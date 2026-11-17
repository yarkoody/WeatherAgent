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
import { BAND_COLOR, FAMILIES, fmt, hubName } from '../lib/format'
import { normalizeHub } from '../lib/normalize'
import type { HubScore, Ranking, ScoreRow, ToolName, WeatherStat, WhatIfResult } from '../lib/types'
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
      // No two numbers glued together, e.g. a score and days: "10027.6 d/yr".
      expect(container.textContent).not.toMatch(/\d{2,}\d+\.\d\s?d(ays)?\/yr/)
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

describe('real weather_stat: the explanation matches the metric unit', () => {
  for (const c of of('weather_stat')) {
    const s = c.output as unknown as WeatherStat
    it(`${s.hub_id} ${s.metric}`, () => {
      const steps = explain.weatherStatSteps(s)
      const detail = explain.weatherStatDetail(s)
      const text = [...steps, ...detail].join(' ')
      expect(text).not.toMatch(/undefined|NaN/)
      if (s.unit === 'mm' || s.unit === 'cm') {
        // A total is a sum over the year, never "N of the 365 days".
        expect(text).not.toMatch(/ of the \d+ days/)
        expect(steps[0]).toBe(`Added up over the ${s.denominator} days of ${s.year}: ${s.value} ${s.unit}.`)
      } else {
        expect(steps[0]).toContain(`${s.numerator} of the ${s.denominator} days in ${s.year} met the threshold`)
        if (s.unit === '%') expect(steps[0]).toContain(`${s.value}%`)
      }
      // The headline keeps the tool's precision.
      render(<WeatherStatRing data={s} />)
      const shown = s.unit === '%' ? `${s.value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%` : s.value.toLocaleString('en-US', { maximumFractionDigits: 1 })
      expect(screen.getAllByText(shown, { exact: false }).length).toBeGreaterThan(0)
    })
  }

  it('a 10.1% share shows as 10.1%, not 10%', () => {
    const s = of('weather_stat')[0].output as unknown as WeatherStat
    render(<WeatherStatRing data={{ ...s, unit: '%', value: 10.1, numerator: 37, denominator: 366 }} />)
    expect(screen.getByText('10.1%')).toBeInTheDocument()
  })
})

describe('cards: one "How to read this" per widget, no (i) per field, units and bands spelled out', () => {
  it('compare_hubs: an aligned table, one "How to read this", no tips inside', () => {
    for (const c of of('compare_hubs')) {
      const { container, unmount } = render(<ComparisonCards data={c.output as never} />)
      expect(within(container).getAllByRole('button', { name: 'How to read this' })).toHaveLength(1)
      const table = within(container).getByRole('table')
      // The only buttons in the table are the column sort controls (no (i) tips inside).
      for (const b of within(table).queryAllByRole('button')) expect(b.getAttribute('aria-label')).toMatch(/^Sort hubs by /)
      const hubs = (c.output as unknown as { hubs: HubScore[] }).hubs
      for (const h of hubs) {
        const row = within(table).getByRole('rowheader', { name: hubName(h.hub_id) }).closest('tr')!
        expect(row.querySelector('td[data-column="exposure"] [data-max], td[data-column="exposure"] span.rounded-md')!.textContent).toBe(fmt(h.exposure))
      }
      unmount()
    }
  })

  it('the legend uses the tool thresholds', async () => {
    const hub = of('get_hub_risk')[0].output as unknown as HubScore
    const t = hub.band_thresholds
    const { container } = render(<HubBreakdown data={hub} />)
    const guides = within(container).getAllByRole('button', { name: 'How to read this' })
    expect(guides).toHaveLength(1)
    expect(within(container).queryAllByRole('button', { name: /^How is the/ })).toHaveLength(0)
    fireEvent.click(guides[0])
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent(`lost days a year ÷ ${t.days_cap} × 100`)
    expect(dialog).toHaveTextContent(`Medium from ${t.medium_from_days} days a year, high from ${t.high_from_days} days a year`)
    expect(dialog).toHaveTextContent("It doesn't include upgrade costs or existing protection, so it's a starting point for a decision, not the decision itself.")
    expect(dialog).toHaveTextContent(`Medium from ${t.family_medium_from_days} days, high from ${t.family_high_from_days} days`)
    expect(dialog).toHaveTextContent(`Medium from ${t.hurricane_medium_from_pct}%, high from ${t.hurricane_high_from_pct}%`)
  })

  it('hazard rankings color bars by the hazard level the tool returns (the level the answer cites)', () => {
    const c = of('rank_hubs').find((x) => x.input.hazard === 'winter')!
    const data = c.output as unknown as Ranking
    const { container } = render(<RankingWidget data={data} />)
    expect(container.textContent).toMatch(/Color: the winter level\. Medium from 2 lost days a year \(score 8\), high from 5 \(score 20\)/)
    expect(container.textContent).not.toMatch(/medium from 35/)
    // every bar's color is the band the tool gave that hub
    const fills = [...container.querySelectorAll('.recharts-bar-rectangle path, .recharts-rectangle')].map((e) => e.getAttribute('fill')).filter((f) => f && f.startsWith('var(--color-band'))
    if (fills.length) expect(fills).toEqual(data.items.map((i) => BAND_COLOR[i.band!]))
  })
})
