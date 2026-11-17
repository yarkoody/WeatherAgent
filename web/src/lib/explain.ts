// "How is this calculated?" text. Every number comes from the tool output (signals, scores, thresholds);
// the only fixed text is the wording around them.
import { FAMILIES, FAMILY_LABEL } from './format'
import type { BandThresholds, FamilyScore, HubScore, Signal } from './types'

const n = (v: number) => String(v)

/** One FEMA or observed-weather signal of a hazard family, in days per year. */
export function signalLine(s: Signal): string {
  if (s.raw === null) return `${s.name}: ${s.note ?? 'no data'}, counted as 0 days/yr`
  const converted = s.unit === 'days/year' ? `${n(s.raw)} days/yr` : `${n(s.raw)} ${s.unit} → ${n(s.normalized)} days/yr`
  return `${s.name}: ${converted} × ${n(s.weight)} = ${n(s.contribution)} days/yr`
}

export function familyLines(f: FamilyScore): string[] {
  return [...f.signals.map(signalLine), `${FAMILY_LABEL[f.family]} total: ${n(f.days_per_year)} days/yr → score ${n(f.score)}`]
}

export function indexLine(t: BandThresholds): string {
  return `Index = days per year ÷ ${n(t.days_cap)} × 100, capped at 100. Medium from ${n(t.medium_from_days)} days a year, high from ${n(t.high_from_days)}.`
}

/** Overall exposure: the hazard families add up to the expected disruption days per year. */
export function exposureLines(s: HubScore): string[] {
  return [
    ...FAMILIES.map((f) => `${FAMILY_LABEL[f]}: ${n(s.families[f]?.days_per_year ?? 0)} days/yr`),
    `Total: ${n(s.exposure_days_per_year)} days/yr → exposure index ${n(s.exposure)}`,
  ]
}

/** Investment priority: weighted blend of 0-100 signals. */
export function priorityLines(s: HubScore): string[] {
  return [
    ...s.priority_signals.map((p) => {
      const raw = p.raw === null ? (p.note ?? 'no data') : `${n(p.raw)} ${p.unit}`
      const cap = p.cap !== null ? ` ÷ cap ${n(p.cap)}` : ''
      return `${p.name}: ${raw}${cap} → ${n(p.normalized)} × ${n(p.weight)} = ${n(p.contribution)}`
    }),
    `Priority: ${n(s.priority)} (bands: medium from ${n(s.band_thresholds.medium_from)}, high from ${n(s.band_thresholds.high_from)})`,
  ]
}
