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
  winter: '#7FA6CC',
  flood: '#2F5D8A',
  hurricane: '#5B4E8C',
  severe_storm: '#7C8A94',
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
  low: '#2f6656',
  medium: '#7a5612',
  high: '#9b2f2a',
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

/** Large numbers for display: 472K, 2.6M, 1.2B. */
export function compact(value: number): string {
  return COMPACT.format(value)
}

/** Display number: compact when large, otherwise at most one decimal (days, scores). Display only, never for verification. */
export function fmt(value: number, digits = 1): string {
  if (Math.abs(value) >= 10_000) return compact(value)
  return value.toLocaleString('en-US', { maximumFractionDigits: digits })
}

/** Percent for display: "95%", "10%", "2.4%" (one decimal only below 10). */
export function pct(value: number): string {
  return `${value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 })}%`
}

/** A cited figure exactly as the tool returned it: no rounding. */
export function exact(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 10 })
}

/** A cited figure: its given precision, but large numbers compact (1.28M). Display only. */
export function formatValue(value: number, unit: string): string {
  const v = Math.abs(value) >= 10_000 ? compact(value) : exact(value)
  if (unit === '%') return `${v}%`
  if (unit === 'score 0-100') return v
  return `${v} ${unit}`
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
