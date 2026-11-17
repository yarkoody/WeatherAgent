// Tool outputs reach the widgets from the live backend, from older backends, and from chats saved in this
// browser. Optional or newer fields can be missing or null there, so widgets read a normalized copy: the
// structure is always present (lists, families, thresholds object); missing numbers stay missing and the
// formatters show "n/a". Nothing here invents a number.
import { FAMILIES } from './format'
import type { BandThresholds, Family, FamilyScore, HubComparison, HubScore, Signal } from './types'

const list = <T>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v.filter((x) => x !== null && x !== undefined) : [])

function signal(s: Signal): Signal {
  return { ...s, name: s.name ?? '', source: s.source ?? '', unit: s.unit ?? '' }
}

function family(f: Family, fam: FamilyScore): FamilyScore {
  return { ...fam, family: f, signals: list(fam.signals).map(signal) }
}

export function normalizeHub(raw: HubScore): HubScore {
  const families = Object.fromEntries(
    FAMILIES.flatMap((f) => {
      const fam = raw.families?.[f]
      return fam ? [[f, family(f, fam)]] : []
    }),
  ) as Record<Family, FamilyScore>
  return {
    ...raw,
    families,
    priority_signals: list(raw.priority_signals).map(signal),
    upgrade_categories: list(raw.upgrade_categories),
    band_thresholds: raw.band_thresholds ?? ({} as BandThresholds),
    top_driver: (FAMILIES as readonly string[]).includes(raw.top_driver) ? raw.top_driver : (null as unknown as Family),
  }
}

export function normalizeComparison(raw: HubComparison): HubComparison {
  return { ...raw, hubs: list(raw.hubs).map(normalizeHub), hazards: list(raw.hazards) }
}
