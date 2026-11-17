// "How is this calculated?" text. Every number comes from the tool output (signals, scores, thresholds);
// the only fixed text is the wording around them.
import { FAMILIES, FAMILY_LABEL, compact, fmt, pct } from './format'
import type { BandThresholds, Family, FamilyScore, HubScore, Signal } from './types'

const n = (v: number) => String(v)

/** One FEMA or observed-weather signal of a hazard family, in days per year. */
export function signalLine(s: Signal): string {
  if (s.raw === null) return `${s.name}: ${s.note ?? 'no data'}, counted as 0 days/yr`
  const converted = s.unit === 'days/year' ? `${n(s.raw)} days/yr` : `${n(s.raw)} ${s.unit} → ${n(s.normalized)} days/yr`
  return `${s.name}: ${converted} × ${n(s.weight)} = ${n(s.contribution)} days/yr`
}

export function familyLines(f: FamilyScore): string[] {
  return [...f.signals.map(signalLine), `${FAMILY_LABEL[f.family]} total: ${n(f.days_per_year)} days/yr, ${f.band} band (score ${n(f.score)})`]
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

/** Fixed wording (approved): what the two lenses mean. */
export const LENS_EXPLAINER =
  'Typical year is the expected number of lost days. Bad year is the average across the worst 1 year in 20, because averages hide rare, severe events such as hurricanes.'

/** Each family's share of the bad year, when the data has it. */
function badYearShares(s: HubScore): { family: Family; days: number }[] | null {
  const shares = FAMILIES.map((f) => ({ family: f, days: s.families[f]?.bad_year_days }))
  return shares.every((x) => typeof x.days === 'number') ? (shares as { family: Family; days: number }[]) : null
}

export function badYearLines(s: HubScore): string[] {
  const shares = badYearShares(s)
  return [
    `Typical year: ${n(s.exposure_days_per_year)} days lost on average.`,
    `Bad year: ${n(s.bad_year_days)} days on average across the worst 1 year in 20 (TVaR at 95%).`,
    ...(shares ? [`By hazard: ${shares.map((x) => `${FAMILY_LABEL[x.family].toLowerCase()} ${n(x.days)}`).join(', ')} (they add up to the bad year).`] : []),
  ]
}

/** Family band rule, with the cut-offs from the tool's thresholds. */
export function familyBandLine(t: BandThresholds): string {
  return `A hazard is medium from ${n(t.family_medium_from_days)} days a year and high from ${n(t.family_high_from_days)}; hurricane is banded by its 10-year chance instead.`
}

/** Hurricane: banded by the chance of at least one hurricane-class event in 10 years. */
export function hurricaneLines(s: HubScore): string[] {
  const t = s.band_thresholds
  const freq = s.families.hurricane?.signals.find((x) => x.raw !== null)
  return [
    freq ? `FEMA NRI hurricane frequency: ${n(freq.raw!)} ${freq.unit}.` : 'FEMA NRI has no hurricane frequency for this county.',
    `Chance of at least one hurricane-class event in 10 years: ${n(s.hurricane_10yr_probability_pct)}% chance.`,
    `Band: medium from ${n(t.hurricane_medium_from_pct)}%, high from ${n(t.hurricane_high_from_pct)}%.`,
  ]
}

// ---------- Plain-language steps for the (i) tips: at most five short lines, numbers only from tool data ----------

const r1 = (v: number) => fmt(v) // one decimal, compact when large

/** "winter weather (FEMA NRI, 0.5 days/event)" -> "winter weather" */
const baseName = (name: string) => name.replace(/\s*\(.*$/, '').trim()
/** "... 0.5 days/event)" -> 0.5, the days each event is counted as (part of the tool's own signal name). */
const daysPerEvent = (s: Signal) => {
  const m = /([\d.]+)\s*days\/event/.exec(s.name)
  return m ? Number(m[1]) : s.raw ? s.normalized / s.raw : null
}

function listJoin(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`
}

export function familySteps(f: FamilyScore, t: BandThresholds): string[] {
  const fema = f.signals.filter((s) => s.source.startsWith('FEMA'))
  const observed = f.signals.filter((s) => !s.source.startsWith('FEMA'))
  const known = fema.filter((s) => s.raw !== null)
  const steps: string[] = []
  if (known.length) {
    steps.push(`FEMA expects about ${listJoin(known.map((s) => `${r1(s.raw!)} ${baseName(s.name)}`))} events a year in this county.`)
    const per = known.map(daysPerEvent).filter((d): d is number => d !== null)
    const femaDays = known.reduce((a, s) => a + s.normalized, 0)
    steps.push(
      per.length === known.length
        ? `We count each as ${listJoin(per.map((d) => `${r1(d)}`))} lost day${known.length === 1 && per[0] === 1 ? '' : 's'} per event: about ${r1(femaDays)} lost days a year.`
        : `That works out to about ${r1(femaDays)} lost days a year.`,
    )
  } else if (fema.length) {
    steps.push(`FEMA has no ${listJoin(fema.map((s) => baseName(s.name)))} data for this county, so it counts as zero.`)
  }
  if (observed.length && known.length) {
    const o = observed[0]
    const years = /(\d{4})-\d{2}-\d{2} to (\d{4})/.exec(o.note ?? '')
    const when = years ? ` in ${years[1]}–${years[2]}` : ''
    steps.push(
      `We blend that with what actually happened at the hub${when} (${r1(o.raw ?? 0)} days a year): ${Math.round(fema[0].weight * 100)}% FEMA, ${Math.round(o.weight * 100)}% observed.`,
    )
  }
  const cut = f.family === 'hurricane' ? '' : ` (medium from ${r1(t.family_medium_from_days)} days, high from ${r1(t.family_high_from_days)})`
  steps.push(`Result: about ${f.days_per_year} lost days a year, which counts as ${f.band ?? 'unrated'}${cut}.`)
  return steps
}

export function indexSteps(t: BandThresholds): string[] {
  return [
    `Score = lost days ÷ ${r1(t.days_cap)} × 100. ${r1(t.days_cap)} days a year counts as the maximum.`,
    `Medium from ${r1(t.medium_from_days)} lost days a year, high from ${r1(t.high_from_days)}.`,
  ]
}

export function exposureSteps(s: HubScore): string[] {
  const parts = FAMILIES.map((f) => `${FAMILY_LABEL[f].toLowerCase()} ${r1(s.families[f]?.days_per_year ?? 0)}`)
  return [`Lost days a year by hazard: ${listJoin(parts)}.`, `Together: about ${r1(s.exposure_days_per_year)} lost days in a typical year.`, ...indexSteps(s.band_thresholds)]
}

const DRIVER: Record<Family, { name: string; plural: boolean }> = {
  winter: { name: 'Winter weather', plural: false },
  flood: { name: 'Flooding', plural: false },
  hurricane: { name: 'Hurricanes', plural: true },
  severe_storm: { name: 'Severe storms', plural: true },
}

export function badYearSteps(s: HubScore): string[] {
  const steps = [`In the worst 1 year in 20, this hub loses on average about ${r1(s.bad_year_days)} days.`]
  const shares = badYearShares(s)
  if (shares && s.bad_year_days > 0) {
    const top = [...shares].sort((a, b) => b.days - a.days)[0]
    const d = DRIVER[top.family]
    steps.push(
      top.days > s.bad_year_days / 2
        ? `${d.name} ${d.plural ? 'drive' : 'drives'} most of that (${r1(top.days)} days).`
        : `${d.name} is the largest part (${r1(top.days)} days).`,
    )
  }
  steps.push(`In a typical year it loses about ${r1(s.exposure_days_per_year)} days.`)
  return steps
}

export function hurricaneSteps(s: HubScore): string[] {
  const t = s.band_thresholds
  const freq = s.families.hurricane?.signals.find((x) => x.raw !== null)
  return [
    freq ? `FEMA expects about ${freq.raw} hurricanes a year near this hub.` : 'FEMA has no hurricane data for this county.',
    `That is a ${pct(s.hurricane_10yr_probability_pct)} chance of at least one in the next 10 years.`,
    `Hurricane risk counts as medium from a ${pct(t.hurricane_medium_from_pct)} chance, high from ${pct(t.hurricane_high_from_pct)}.`,
  ]
}

export function prioritySteps(s: HubScore): string[] {
  const plain = (p: Signal) => {
    const n0 = baseName(p.name)
    if (p.unit === 'people' && p.raw !== null) return `${n0}: ${compact(p.raw)} people, worth ${r1(p.normalized)} of 100 points`
    return `${n0}: ${r1(p.normalized)} of 100 points`
  }
  return [
    'Investment priority says where upgrades would help most. It mixes three things:',
    ...s.priority_signals.map((p) => `${plain(p)}, counting for ${Math.round(p.weight * 100)}%.`),
    `Result: ${r1(s.priority)} of 100.`,
  ]
}
