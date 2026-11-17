// "See the math" shows each hub's real calculation, and every number in it comes from the tool output.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { mathSections } from '../lib/math'
import type { HubScore } from '../lib/types'
import hubScoresJson from '../mocks/hub-scores.json'
import { HubBreakdown } from '../widgets/HubBreakdown'
import real from './real/tool-outputs.json'

const realHubs = (real as unknown as { tool: string; output: Record<string, unknown> }[])
  .filter((c) => c.tool === 'get_hub_risk' && !('error' in c.output))
  .map((c) => c.output as unknown as HubScore)
const mockHubs = Object.values(hubScoresJson as unknown as Record<string, HubScore>) // these carry people fields

/** Every number the tool output contains: numeric values and numbers written inside its strings (names, notes). */
function toolNumbers(value: unknown, out = new Set<number>()): Set<number> {
  if (typeof value === 'number') out.add(value)
  else if (typeof value === 'string') for (const m of value.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.add(Number(m[0].replace(/,/g, '')))
  else if (Array.isArray(value)) value.forEach((v) => toolNumbers(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => toolNumbers(v, out))
  return out
}
/** Fixed parts of the formulas themselves: 1 in 20 years, 10-year chance, ×100 scales, "1 −". */
const FORMULA_CONSTANTS = [0, 1, 10, 20, 100]

function allowed(hub: HubScore): number[] {
  const nums = [...toolNumbers(hub)]
  // A weight or share may be shown as a percent (0.6 → 60%).
  return [...nums, ...nums.map((x) => Math.round(x * 100 * 1e6) / 1e6), ...FORMULA_CONSTANTS]
}

function check(hub: HubScore) {
  const text = mathSections(hub)
    .flatMap((s) => s.lines.map((l) => l.text))
    .join('\n')
  const ok = allowed(hub)
  const shown = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')))
  expect(shown.length).toBeGreaterThan(20)
  for (const x of shown) expect(ok.some((y) => Math.abs(x - y) < 1e-9), `${hub.hub_id}: ${x} is not in the tool output`).toBe(true)
  return text
}

describe('See the math', () => {
  for (const hub of realHubs) {
    it(`${hub.hub_id}: every number shown is a tool value`, () => {
      const text = check(hub)
      // The steps are there, in order, with the hub's own values.
      expect(text).toContain(`= ${hub.exposure_days_per_year} days/yr`)
      expect(text).toContain(`exposure score = ${hub.exposure_days_per_year} ÷ ${hub.band_thresholds.days_cap} × 100 = ${hub.exposure} (capped at 100)`)
      expect(text).toContain('average of the worst 1 year in 20, computed exactly from the same event rates')
      expect(text).toMatch(new RegExp(`[=≈] ${hub.priority}(\\n|$)`))
      // The blend is a real equation: weight × FEMA days + weight × observed days.
      expect(text).toMatch(/blend = 0\.6 × (\([\d.]+( \+ [\d.]+)+\)|[\d.]+) FEMA \+ 0\.4 × [\d.]+ observed \(2015–2025\) = [\d.]+ days\/yr/)
      expect(text).toContain(`bad year = `)
      expect(text).toMatch(new RegExp(`[=≈] ${hub.bad_year_days} days`))
      expect(text).not.toMatch(/× 1 days/)
    })
  }

  it('people-days use the people fields when present (mock data)', () => {
    for (const hub of mockHubs) {
      const text = check(hub)
      expect(text).toMatch(new RegExp(`[=≈] ${hub.people_days_m} million a year`))
    }
  })

  it('shows local-area and coastal scaling from the signal notes, and the hurricane formula', () => {
    const houston = realHubs.find((h) => h.hub_id === 'houston')!
    const text = mathSections(houston)
      .flatMap((s) => s.lines.map((l) => l.text))
      .join('\n')
    expect(text).toMatch(/inland flood: [\d.]+ events\/yr × 2 days × [\d.]+ local area \(county [\d,]+ sq mi\) = [\d.]+ days/)
    expect(text).toMatch(/coastal flood: [\d.]+ events\/yr × 2 days × [\d.]+% of the county in the coastal zone = [\d.]+ days/)
    expect(text).toContain(`= ${houston.hurricane_10yr_probability_pct}%`)
    expect(text).toMatch(/chance = 1 − e\^\(−10 × [\d.]+\)/)
  })

  it('in the breakdown: closed by default, with a Methodology button', () => {
    render(<HubBreakdown data={realHubs[0]} />)
    const math = screen.getByTestId('see-the-math')
    expect(math).not.toHaveAttribute('open')
    fireEvent.click(within(math).getByText('See the math'))
    expect(within(math).getByRole('button', { name: 'Methodology' })).toBeInTheDocument()
  })

  it('a sum line uses = only when the shown parts add up to the shown total, ≈ otherwise', () => {
    for (const hub of [...realHubs, ...mockHubs]) {
      for (const line of mathSections(hub).flatMap((s) => s.lines.map((l) => l.text))) {
        const m = /^(?:bad year|typical year) = (.+) ([=≈]) ([\d.]+) days/.exec(line)
        if (!m) continue
        const parts = [...m[1].matchAll(/[\d.]+/g)].map((x) => Number(x[0]))
        const exact = Math.abs(parts.reduce((a, b) => a + b, 0) - Number(m[3])) < 1e-9
        expect(m[2], `${hub.hub_id}: ${line}`).toBe(exact ? '=' : '≈')
      }
    }
  })

  it('review priority and people-days use ≈ when the shown numbers do not multiply or add up exactly', () => {
    for (const hub of [...realHubs, ...mockHubs]) {
      const text = mathSections(hub).flatMap((s) => s.lines.map((l) => l.text))
      const sum = text.find((l) => /^= [\d.]+ \+ [\d.]+ \+ [\d.]+ [=≈]/.test(l))
      if (sum) {
        const m = /^= ([\d.]+) \+ ([\d.]+) \+ ([\d.]+) ([=≈]) ([\d.]+)/.exec(sum)!
        const exact = Math.abs(Number(m[1]) + Number(m[2]) + Number(m[3]) - Number(m[5])) < 1e-9
        expect(m[4], `${hub.hub_id}: ${sum}`).toBe(exact ? '=' : '≈')
      }
      const pd = text.find((l) => l.startsWith('people-days = '))
      if (pd) {
        const m = /people-days = ([\d,]+) people × ([\d.]+) days ([=≈]) ([\d.]+) million/.exec(pd)!
        const exact = Math.abs(Math.round((Number(m[1].replace(/,/g, '')) * Number(m[2])) / 1e5) / 10 - Number(m[4])) < 1e-9
        expect(m[3], `${hub.hub_id}: ${pd}`).toBe(exact ? '=' : '≈')
      }
    }
  })

  it('the KaTeX blend labels both parts (FEMA and observed)', () => {
    const tex = realHubs.flatMap((h) => mathSections(h).flatMap((s) => s.lines)).filter((l) => l.text.startsWith('blend ='))
    expect(tex.length).toBeGreaterThan(0)
    for (const l of tex) expect(l.tex).toMatch(/_\{\\text\{FEMA\}\}.*_\{\\text\{observed/)
  })

  it('people share shows the log formula from the signal note', () => {
    for (const hub of [...realHubs, ...mockHubs]) {
      const p = hub.priority_signals?.find((x) => x.unit === 'people')
      if (!p?.note?.includes('log10')) continue
      const text = mathSections(hub).flatMap((s) => s.lines.map((l) => l.text)).join('\n')
      expect(text).toContain(`people share = log10(`)
      expect(text).toContain(`= ${p.normalized}%`)
    }
  })
})

describe('See the math with KaTeX', () => {
  it('loads KaTeX when opened and renders every formula line with the hub numbers substituted', async () => {
    const hub = realHubs[0]
    render(<HubBreakdown data={hub} />)
    const math = screen.getByTestId('see-the-math') as HTMLDetailsElement
    math.open = true
    fireEvent(math, new Event('toggle'))
    await waitFor(() => expect(math.querySelector('[data-math] .katex')).not.toBeNull(), { timeout: 5000 })
    const rendered = [...math.querySelectorAll('[data-math]')]
    const withTex = mathSections(hub).flatMap((s) => s.lines).filter((l) => l.tex)
    expect(rendered).toHaveLength(withTex.length)
    // The exposure formula carries the hub's own numbers.
    expect(math.textContent).toContain(String(hub.exposure_days_per_year))
    expect(math.textContent).toContain(String(hub.band_thresholds.days_cap))
  })
})
