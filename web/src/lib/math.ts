// "See the math": the hub's actual calculation, step by step, built only from the get_hub_risk tool output.
// Every number shown is a tool value (or a percent form of a tool weight); nothing is recomputed here.
// Each line has plain text (tests, screen readers, copy) and the same line as TeX (rendered with KaTeX).
import { FAMILIES, FAMILY_LABEL, isNum } from './format'
import type { HubScore, Signal } from './types'

export interface MathLine {
  text: string
  /** The same step as TeX with the hub's numbers substituted; absent for a sentence that is not a formula. */
  tex?: string
}

export interface MathSection {
  title: string
  lines: MathLine[]
}

/** Exact tool value, with thousands separators for big numbers (people). */
const n = (v: number | null | undefined) => (isNum(v) ? (Math.abs(v) >= 10_000 ? v.toLocaleString('en-US') : String(v)) : 'n/a')
/** The same value in TeX ({,} keeps the comma from adding space). */
const tn = (v: number | null | undefined) => n(v).replace(/,/g, '{,}')
/** Text inside \text{…}, with TeX specials escaped. */
const tt = (s: string) => `\\text{${s.replace(/([\\{}$&#_%^~])/g, (c) => (c === '\\' ? '\\textbackslash{}' : c === '^' ? '\\^{}' : c === '~' ? '\\~{}' : `\\${c}`))}}`

const baseName = (s: Signal) => s.name.replace(/\s*\(.*$/, '').trim()
const daysPerEvent = (s: Signal) => /([\d.]+)\s*days\/event/.exec(s.name)?.[1]
/** "=" when the shown parts add up to the shown total, "≈" when rounding each part makes them differ. */
function sumSign(parts: (number | null | undefined)[], total: number | null | undefined): { text: string; tex: string } {
  const sum = parts.reduce<number>((a, x) => a + (isNum(x) ? x : 0), 0)
  return isNum(total) && Math.abs(sum - total) < 1e-9 ? { text: '=', tex: '=' } : { text: '≈', tex: '\\approx' }
}
/** "=" when people × days, in millions at one decimal, gives the shown value; "≈" when it was computed before rounding. */
function productSign(people: number, days: number | null | undefined, shown: number): { text: string; tex: string } {
  const exact = isNum(days) && Math.abs(Math.round((people * days) / 1e5) / 10 - shown) < 1e-9
  return exact ? { text: '=', tex: '=' } : { text: '≈', tex: '\\approx' }
}
const ROUNDING_NOTE = '≈ : computed from unrounded values, so the rounded numbers shown can differ slightly'
/** "1 day", "0.5 days". */
const perYear = (v: number) => (v === 1 ? 'day/yr' : 'days/yr')
const days = (v: string | number) => `${v} ${Number(v) === 1 ? 'day' : 'days'}`
const isFema = (s: Signal) => s.source?.startsWith('FEMA')

/** Local-area or coastal-zone scaling, from the signal note. */
function scaling(s: Signal): { text: string; tex: string } | null {
  const area = /area-adjusted x([\d.]+) \(county ([\d,]+) sq mi\)/.exec(s.note ?? '')
  if (area) return { text: `× ${area[1]} local area (county ${area[2]} sq mi)`, tex: `\\times ${area[1]}\\ ${tt(`local area (county ${area[2]} sq mi)`)}` }
  const coast = /([\d.]+)% of county area exposed/.exec(s.note ?? '')
  if (coast) return { text: `× ${coast[1]}% of the county in the coastal zone`, tex: `\\times ${coast[1]}\\%\\ ${tt('of the county in the coastal zone')}` }
  return null
}

function familySection(s: HubScore, f: (typeof FAMILIES)[number]): MathSection | null {
  const fam = s.families?.[f]
  if (!fam) return null
  const lines: MathLine[] = []
  const fema = (fam.signals ?? []).filter(isFema)
  const observed = (fam.signals ?? []).filter((x) => !isFema(x))
  for (const sig of fema) {
    const dpe = daysPerEvent(sig) ?? '?'
    if (!isNum(sig.raw)) {
      lines.push({ text: `${baseName(sig)}: not in FEMA data for this county = 0 days`, tex: `${tt(`${baseName(sig)}: not in FEMA data for this county`)} = 0\\ ${tt('days')}` })
      continue
    }
    const scale = scaling(sig)
    lines.push({
      text: `${baseName(sig)}: ${n(sig.raw)} events/yr × ${days(dpe)}${scale ? ` ${scale.text}` : ''} = ${n(sig.normalized)} days`,
      tex: `${tt(`${baseName(sig)}:`)}\\ ${tn(sig.raw)}\\ ${tt('events/yr')} \\times ${dpe}\\ ${tt(Number(dpe) === 1 ? 'day' : 'days')}${scale ? ` ${scale.tex}` : ''} = ${tn(sig.normalized)}\\ ${tt('days')}`,
    })
  }
  const femaW = fema[0]?.weight
  const obs = observed[0]
  const femaDays = fema.map((x) => x.normalized)
  const femaSum = femaDays.length > 1 ? `(${femaDays.map(n).join(' + ')})` : n(femaDays[0])
  const femaSumTex = `${femaDays.length > 1 ? `\\left(${femaDays.map(tn).join(' + ')}\\right)` : tn(femaDays[0])}_{${tt('FEMA')}}`
  if (obs && isNum(femaW) && isNum(obs.weight)) {
    const years = /(\d{4})-\d{2}-\d{2} to (\d{4})/.exec(obs.note ?? '')
    const span = years ? `, ${years[1]}–${years[2]}` : ''
    // The blend itself, with the FEMA days above and the observed days at the hub: weight × FEMA + weight × observed.
    lines.push({
      text: `blend = ${n(femaW)} × ${femaSum} FEMA + ${n(obs.weight)} × ${n(obs.raw)} observed (${years ? `${years[1]}–${years[2]}` : 'hub point'}) = ${n(fam.days_per_year)} ${perYear(fam.days_per_year)}`,
      tex: `${tt('blend')} = ${tn(femaW)} \\times ${femaSumTex} + ${tn(obs.weight)} \\times ${tn(obs.raw)}_{${tt(`observed${span}`)}} = ${tn(fam.days_per_year)}\\ ${tt(perYear(fam.days_per_year))}`,
    })
  } else {
    const why = f === 'hurricane' ? ' (weather observations do not record hurricanes)' : ''
    lines.push({
      text: `FEMA only${why} → ${n(fam.days_per_year)} ${perYear(fam.days_per_year)}`,
      tex: `${tt(`FEMA only${why}`)} \\rightarrow ${tn(fam.days_per_year)}\\ ${tt(perYear(fam.days_per_year))}`,
    })
  }
  return { title: FAMILY_LABEL[f], lines }
}

/** People share on its log scale: log10(pop / floor) / log10(cap / floor), with floor and cap from the signal note. */
function peopleLine(p: Signal): MathLine {
  const m = /log10\(pop \/ ([\d.]+)M\) \/ log10\(([\d.]+)M \/ [\d.]+M\)/.exec(p.note ?? '')
  if (!m) return { text: `people share: ${n(p.raw)} people on a log scale up to ${n(p.cap)} → ${n(p.normalized)}%` }
  const [, floor, cap] = m
  return {
    text: `people share = log10(${n(p.raw)} ÷ ${floor}M) ÷ log10(${cap}M ÷ ${floor}M) = ${n(p.normalized)}%`,
    tex: `s_{p} = \\frac{\\log_{10}(${tn(p.raw)} \\,/\\, ${floor}${tt('M')})}{\\log_{10}(${cap}${tt('M')} \\,/\\, ${floor}${tt('M')})} = ${tn(p.normalized)}\\%`,
  }
}

export function mathSections(s: HubScore): MathSection[] {
  const t = s.band_thresholds ?? ({} as HubScore['band_thresholds'])
  const sections: MathSection[] = FAMILIES.map((f) => familySection(s, f)).filter((x): x is MathSection => x !== null)

  const fams = FAMILIES.filter((f) => s.families?.[f])
  const typicalSign = sumSign(fams.map((f) => s.families[f].days_per_year), s.exposure_days_per_year)
  sections.push({
    title: 'Typical year and exposure score',
    lines: [
      {
        text: `typical year = ${fams.map((f) => n(s.families[f].days_per_year)).join(' + ')} ${typicalSign.text} ${n(s.exposure_days_per_year)} days/yr`,
        tex: `${tt('typical year')} = ${fams.map((f) => tn(s.families[f].days_per_year)).join(' + ')} ${typicalSign.tex} ${tn(s.exposure_days_per_year)}\\ ${tt('days/yr')}`,
      },
      {
        text: `exposure score = ${n(s.exposure_days_per_year)} ÷ ${n(t.days_cap)} × 100 = ${n(s.exposure)} (capped at 100)`,
        tex: `${tt('exposure score')} = \\min\\!\\left(\\frac{${tn(s.exposure_days_per_year)}}{${tn(t.days_cap)}} \\times 100,\\ 100\\right) = ${tn(s.exposure)}`,
      },
    ],
  })

  if (isNum(s.bad_year_days)) {
    const shareFams = FAMILIES.filter((f) => isNum(s.families?.[f]?.bad_year_days))
    const badSign = sumSign(shareFams.map((f) => s.families[f].bad_year_days), s.bad_year_days)
    sections.push({
      title: 'Bad year',
      lines: [
        { text: 'average of the worst 1 year in 20, computed exactly from the same event rates' },
        shareFams.length
          ? {
              text: `bad year = ${shareFams.map((f) => `${n(s.families[f].bad_year_days)} ${FAMILY_LABEL[f].toLowerCase()}`).join(' + ')} ${badSign.text} ${n(s.bad_year_days)} days`,
              tex: `${tt('bad year')} = ${shareFams.map((f) => `${tn(s.families[f].bad_year_days)}_{${tt(FAMILY_LABEL[f].toLowerCase())}}`).join(' + ')} ${badSign.tex} ${tn(s.bad_year_days)}\\ ${tt('days')}`,
            }
          : { text: `bad year = ${n(s.bad_year_days)} days`, tex: `${tt('bad year')} = ${tn(s.bad_year_days)}\\ ${tt('days')}` },
        ...(badSign.text === '≈' || typicalSign.text === '≈' ? [{ text: '≈ : each part is rounded on its own, so their sum can differ slightly from the total' }] : []),
      ],
    })
  }

  const hurricane = s.families?.hurricane?.signals?.find((x) => isFema(x) && isNum(x.raw))
  if (hurricane && isNum(s.hurricane_10yr_probability_pct))
    sections.push({
      title: 'Hurricane 10-year chance',
      lines: [
        {
          text: `chance = 1 − e^(−10 × ${n(hurricane.raw)}) = ${n(s.hurricane_10yr_probability_pct)}%`,
          tex: `P_{10} = 1 - e^{-10 \\times ${tn(hurricane.raw)}} = ${tn(s.hurricane_10yr_probability_pct)}\\%`,
        },
      ],
    })

  const [base, people, gap] = [
    s.priority_signals?.find((p) => /exposure/.test(p.name)),
    s.priority_signals?.find((p) => p.unit === 'people'),
    s.priority_signals?.find((p) => /resilience/.test(p.name)),
  ]
  if (base && people && gap) {
    const prioSign = sumSign([base.contribution, people.contribution, gap.contribution], s.priority)
    sections.push({
      title: 'Review priority',
      lines: [
        peopleLine(people),
        {
          text: `recovery gap share: 100 − ${n(gap.raw)} resilience score → ${n(gap.normalized)}%`,
          tex: `s_{r} = 100 - ${tn(gap.raw)} = ${tn(gap.normalized)}\\%`,
        },
        {
          text: `review priority = exposure × (${n(base.weight)} + ${n(people.weight)} × people share + ${n(gap.weight)} × recovery gap share)`,
          tex: `${tt('review priority')} = E \\times \\left(${tn(base.weight)} + ${tn(people.weight)}\\,s_{p} + ${tn(gap.weight)}\\,s_{r}\\right)`,
        },
        {
          text: `= ${n(base.raw)} × (${n(base.weight)} + ${n(people.weight)} × ${n(people.normalized)}% + ${n(gap.weight)} × ${n(gap.normalized)}%)`,
          tex: `= ${tn(base.raw)} \\times \\left(${tn(base.weight)} + ${tn(people.weight)} \\times ${tn(people.normalized)}\\% + ${tn(gap.weight)} \\times ${tn(gap.normalized)}\\%\\right)`,
        },
        {
          text: `= ${n(base.contribution)} + ${n(people.contribution)} + ${n(gap.contribution)} ${prioSign.text} ${n(s.priority)}`,
          tex: `= ${tn(base.contribution)} + ${tn(people.contribution)} + ${tn(gap.contribution)} ${prioSign.tex} ${tn(s.priority)}`,
        },
        ...(prioSign.text === '≈' ? [{ text: ROUNDING_NOTE }] : []),
      ],
    })
  }

  if (isNum(s.people_served) && s.people_served > 0 && isNum(s.people_days_m)) {
    const typ = productSign(s.people_served, s.exposure_days_per_year, s.people_days_m)
    const bad = isNum(s.people_days_bad_year_m) ? productSign(s.people_served, s.bad_year_days, s.people_days_bad_year_m) : typ
    sections.push({
      title: 'People-days',
      lines: [
        {
          text: `people-days = ${n(s.people_served)} people × ${n(s.exposure_days_per_year)} days ${typ.text} ${n(s.people_days_m)} million a year`,
          tex: `${tt('people-days')} = ${tn(s.people_served)} \\times ${tn(s.exposure_days_per_year)} ${typ.tex} ${tn(s.people_days_m)}\\ ${tt('million a year')}`,
        },
        ...(isNum(s.people_days_bad_year_m)
          ? [
              {
                text: `bad year: ${n(s.people_served)} × ${n(s.bad_year_days)} days ${bad.text} ${n(s.people_days_bad_year_m)} million`,
                tex: `${tt('bad year')}: ${tn(s.people_served)} \\times ${tn(s.bad_year_days)} ${bad.tex} ${tn(s.people_days_bad_year_m)}\\ ${tt('million')}`,
              },
            ]
          : []),
        ...(typ.text === '≈' || bad.text === '≈' ? [{ text: ROUNDING_NOTE }] : []),
      ],
    })
  }
  return sections
}
