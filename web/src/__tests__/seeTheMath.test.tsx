// "See the math" shows each hub's real calculation, and every number in it comes from the tool output.
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { METHODOLOGY_URL, mathSections } from '../lib/math'
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
    .flatMap((s) => s.lines)
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
      expect(text).toContain(`= ${hub.priority}`)
      expect(text).toMatch(/blended 60% FEMA \/ 40% observed \([\d.]+ days\/yr, 2015–2025\) → [\d.]+ days\/yr/)
    })
  }

  it('people-days use the people fields when present (mock data)', () => {
    for (const hub of mockHubs) {
      const text = check(hub)
      expect(text).toContain(`= ${hub.people_days_m} million a year`)
    }
  })

  it('shows local-area and coastal scaling from the signal notes, and the hurricane formula', () => {
    const houston = realHubs.find((h) => h.hub_id === 'houston')!
    const text = mathSections(houston)
      .flatMap((s) => s.lines)
      .join('\n')
    expect(text).toMatch(/inland flood: [\d.]+ events\/yr × 2 days × [\d.]+ local area \(county [\d,]+ sq mi\) = [\d.]+ days/)
    expect(text).toMatch(/coastal flood: [\d.]+ events\/yr × 2 days × [\d.]+% of the county in the coastal zone = [\d.]+ days/)
    expect(text).toContain(`= ${houston.hurricane_10yr_probability_pct}%`)
    expect(text).toMatch(/chance = 1 − e\^\(−10 × [\d.]+\)/)
  })

  it('in the breakdown: closed by default, monospace lines, a link to the full methodology', () => {
    render(<HubBreakdown data={realHubs[0]} />)
    const math = screen.getByTestId('see-the-math')
    expect(math).not.toHaveAttribute('open')
    fireEvent.click(within(math).getByText('See the math'))
    expect(within(math).getAllByRole('list')[0].className).toContain('font-mono')
    expect(within(math).getByRole('link', { name: 'Full methodology' })).toHaveAttribute('href', METHODOLOGY_URL)
  })
})
