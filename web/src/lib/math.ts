// "See the math": the hub's actual calculation, step by step, built only from the get_hub_risk tool output.
// Every number shown is a tool value (or a percent form of a tool weight or share); nothing is recomputed here.
import { FAMILIES, FAMILY_LABEL, isNum } from './format'
import type { HubScore, Signal } from './types'

export const METHODOLOGY_URL = 'https://github.com/yarkoody/WeatherAgent/blob/main/docs/METHODOLOGY.md'

export interface MathSection {
  title: string
  lines: string[]
}

/** Exact tool value, with thousands separators for big numbers (people). */
const n = (v: number | null | undefined) => (isNum(v) ? (Math.abs(v) >= 10_000 ? v.toLocaleString('en-US') : String(v)) : 'n/a')
/** A weight as a percent: 0.6 → "60%". */
const pctOf = (w: number) => `${Math.round(w * 100)}%`

const baseName = (s: Signal) => s.name.replace(/\s*\(.*$/, '').trim()
const daysPerEvent = (s: Signal) => /([\d.]+)\s*days\/event/.exec(s.name)?.[1]
const isFema = (s: Signal) => s.source?.startsWith('FEMA')

/** "× 0.56 local area (county 1,795 sq mi)" or "× 9.2% of the county in the coastal zone", from the signal note. */
function scaling(s: Signal): string | null {
  const area = /area-adjusted x([\d.]+) \(county ([\d,]+) sq mi\)/.exec(s.note ?? '')
  if (area) return `× ${area[1]} local area (county ${area[2]} sq mi)`
  const coast = /([\d.]+)% of county area exposed/.exec(s.note ?? '')
  if (coast) return `× ${coast[1]}% of the county in the coastal zone`
  return null
}

function familySection(s: HubScore, f: (typeof FAMILIES)[number]): MathSection | null {
  const fam = s.families?.[f]
  if (!fam) return null
  const lines: string[] = []
  const fema = (fam.signals ?? []).filter(isFema)
  const observed = (fam.signals ?? []).filter((x) => !isFema(x))
  for (const sig of fema) {
    const dpe = daysPerEvent(sig)
    if (!isNum(sig.raw)) {
      lines.push(`${baseName(sig)}: no FEMA data for this county = 0 days`)
      continue
    }
    const scale = scaling(sig)
    lines.push(`${baseName(sig)}: ${n(sig.raw)} events/yr × ${dpe ?? '?'} days${scale ? ` ${scale}` : ''} = ${n(sig.normalized)} days`)
  }
  const femaW = fema[0]?.weight
  const obs = observed[0]
  if (obs && isNum(femaW) && isNum(obs.weight)) {
    const years = /(\d{4})-\d{2}-\d{2} to (\d{4})/.exec(obs.note ?? '')
    lines.push(
      `blended ${pctOf(femaW)} FEMA / ${pctOf(obs.weight)} observed (${n(obs.raw)} days/yr${years ? `, ${years[1]}–${years[2]}` : ''}) → ${n(fam.days_per_year)} days/yr`,
    )
  } else {
    lines.push(`FEMA only (no observed blend) → ${n(fam.days_per_year)} days/yr`)
  }
  return { title: FAMILY_LABEL[f], lines }
}

export function mathSections(s: HubScore): MathSection[] {
  const t = s.band_thresholds ?? ({} as HubScore['band_thresholds'])
  const sections: MathSection[] = FAMILIES.map((f) => familySection(s, f)).filter((x): x is MathSection => x !== null)

  const parts = FAMILIES.filter((f) => s.families?.[f]).map((f) => n(s.families[f].days_per_year))
  sections.push({
    title: 'Typical year and exposure score',
    lines: [
      `typical year = ${parts.join(' + ')} = ${n(s.exposure_days_per_year)} days/yr`,
      `exposure score = ${n(s.exposure_days_per_year)} ÷ ${n(t.days_cap)} × 100 = ${n(s.exposure)} (capped at 100)`,
    ],
  })

  if (isNum(s.bad_year_days)) {
    const shares = FAMILIES.filter((f) => isNum(s.families?.[f]?.bad_year_days)).map((f) => `${FAMILY_LABEL[f].toLowerCase()} ${n(s.families[f].bad_year_days)}`)
    sections.push({
      title: 'Bad year',
      lines: [
        'average of the worst 1 year in 20, computed exactly from the same event rates',
        ...(shares.length ? [`by hazard: ${shares.join(' + ')}`] : []),
        `bad year = ${n(s.bad_year_days)} days`,
      ],
    })
  }

  const hurricane = s.families?.hurricane?.signals?.find((x) => isFema(x) && isNum(x.raw))
  if (hurricane && isNum(s.hurricane_10yr_probability_pct))
    sections.push({
      title: 'Hurricane 10-year chance',
      lines: [`chance = 1 − e^(−10 × ${n(hurricane.raw)}) = ${n(s.hurricane_10yr_probability_pct)}%`],
    })

  const [base, people, gap] = [
    s.priority_signals?.find((p) => /exposure/.test(p.name)),
    s.priority_signals?.find((p) => p.unit === 'people'),
    s.priority_signals?.find((p) => /resilience/.test(p.name)),
  ]
  if (base && people && gap) {
    sections.push({
      title: 'Review priority',
      lines: [
        `people share: ${n(people.raw)} people on a log scale up to ${n(people.cap)} → ${n(people.normalized)}%`,
        `recovery gap share: 100 − ${n(gap.raw)} resilience score → ${n(gap.normalized)}%`,
        `review priority = exposure × (${n(base.weight)} + ${n(people.weight)} × people share + ${n(gap.weight)} × recovery gap share)`,
        `= ${n(base.raw)} × (${n(base.weight)} + ${n(people.weight)} × ${n(people.normalized)}% + ${n(gap.weight)} × ${n(gap.normalized)}%)`,
        `= ${n(base.contribution)} + ${n(people.contribution)} + ${n(gap.contribution)} = ${n(s.priority)}`,
      ],
    })
  }

  if (isNum(s.people_served) && s.people_served > 0 && isNum(s.people_days_m))
    sections.push({
      title: 'People-days',
      lines: [
        `people-days = ${n(s.people_served)} people × ${n(s.exposure_days_per_year)} days = ${n(s.people_days_m)} million a year`,
        ...(isNum(s.people_days_bad_year_m) ? [`bad year: ${n(s.people_served)} × ${n(s.bad_year_days)} days = ${n(s.people_days_bad_year_m)} million`] : []),
      ],
    })
  return sections
}
