import type { Band, Family, Hazard, Metric } from './types'

const HUB_NAMES: Record<string, string> = {
  kansas_city: 'Kansas City',
  los_angeles: 'Los Angeles',
}

/** Display name from a hub id ("kansas_city" -> "Kansas City"). Tool data only carries ids in most places. */
export function hubName(id: string | null | undefined): string {
  if (!id) return 'All hubs'
  return HUB_NAMES[id] ?? id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** "Minneapolis Hub" -> "Minneapolis": ranking items carry the full hub name. */
export function shortHubName(name: string): string {
  return name.replace(/\s+Hub$/i, '')
}

export const FAMILIES: Family[] = ['winter', 'flood', 'hurricane', 'severe_storm']

export const FAMILY_LABEL: Record<Family, string> = {
  winter: 'Winter',
  flood: 'Flood',
  hurricane: 'Hurricane',
  severe_storm: 'Severe storm',
}

export const FAMILY_COLOR: Record<Family, string> = {
  winter: 'var(--color-hazard-winter)',
  flood: 'var(--color-hazard-flood)',
  hurricane: 'var(--color-hazard-hurricane)',
  severe_storm: 'var(--color-hazard-severe_storm)',
}

export const HAZARD_LABEL: Record<Hazard, string> = { overall: 'Overall', ...FAMILY_LABEL }

export const BAND_LABEL: Record<Band, string> = { low: 'Low', medium: 'Medium', high: 'High' }

export const BAND_COLOR: Record<Band, string> = {
  low: '#5E9483',
  medium: '#D29A2E',
  high: '#C2413B',
}

/** Darker band shades for text on light backgrounds (WCAG AA for small labels). */
export const BAND_LABEL_COLOR: Record<Band, string> = {
  low: 'var(--color-band-low-text)',
  medium: 'var(--color-band-medium-text)',
  high: 'var(--color-band-high-text)',
}

export const METRIC_LABEL: Record<Metric, string> = {
  snow_days_pct: 'snow days',
  heavy_rain_days: 'heavy-rain days',
  freezing_days_pct: 'freezing days',
  high_wind_days: 'high-wind days',
  total_snowfall_cm: 'total snowfall',
  total_precip_mm: 'total precipitation',
}

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumSignificantDigits: 3 })

/** Shown wherever a number is missing (null, undefined or not finite), so a gap never crashes a widget. */
export const NA = 'n/a'
/** True for a usable number; tool outputs from older backends or saved chats can lack optional fields. */
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Large numbers for display: 472K, 2.6M, 1.2B. */
export function compact(value: number | null | undefined): string {
  return isNum(value) ? COMPACT.format(value) : NA
}

/** Display number: compact when large, otherwise at most one decimal (days, scores). Display only, never for verification. */
export function fmt(value: number | null | undefined, digits = 1): string {
  if (!isNum(value)) return NA
  if (Math.abs(value) >= 10_000) return compact(value)
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

/** Percent for display at the tools' own precision (one decimal): "95%", "10.1%", "2.4%". */
export function pct(value: number | null | undefined): string {
  if (!isNum(value)) return NA
  return `${value.toLocaleString('en-US', { maximumFractionDigits: 1 })}%`
}

/** A cited figure exactly as the tool returned it: no rounding. */
export function exact(value: number | null | undefined): string {
  return isNum(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 10 }) : NA
}

/** A cited figure: its given precision, but large numbers compact (1.28M). Display only. */
export function formatValue(value: number | null | undefined, unit: string): string {
  if (!isNum(value)) return NA
  const v = Math.abs(value) >= 10_000 ? compact(value) : exact(value)
  if (unit === '%') return `${v}%`
  if (unit === 'score 0-100') return v
  return `${v} ${unit}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "2026-11-17" or an ISO timestamp -> "Nov 17, 2026". Uses the calendar date as written, so no time-zone shift. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return NA
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  const [, y, mo, d] = m
  const month = MONTHS[Number(mo) - 1]
  return month ? `${month} ${Number(d)}, ${y}` : iso
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return NA
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
