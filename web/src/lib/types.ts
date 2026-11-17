// TypeScript mirrors of app/schemas.py (the source of truth). Keep field names identical.

export type Region = 'Midwest' | 'South' | 'West' | 'Northeast'
export type Family = 'winter' | 'flood' | 'hurricane' | 'severe_storm'
export type Hazard = 'overall' | Family
export type ScoreKind = 'exposure' | 'priority'
export type Band = 'low' | 'medium' | 'high'
export type Metric =
  | 'snow_days_pct'
  | 'heavy_rain_days'
  | 'freezing_days_pct'
  | 'high_wind_days'
  | 'total_snowfall_cm'
  | 'total_precip_mm'

export interface Hub {
  id: string
  name: string
  city: string
  state: string
  region: Region
  lat: number
  lon: number
  county_fips: string
}

export interface Signal {
  name: string
  source: string
  raw: number | null
  unit: string
  cap: number | null
  normalized: number
  weight: number
  contribution: number
  note?: string | null
}

export interface FamilyScore {
  family: Family
  score: number
  days_per_year: number
  signals: Signal[]
}

export interface BandThresholds {
  medium_from: number
  high_from: number
}

export interface HubScore {
  hub_id: string
  exposure: number
  exposure_days_per_year: number
  exposure_band: Band
  families: Record<Family, FamilyScore>
  family_weights: Record<Family, number>
  priority: number
  priority_band: Band
  priority_signals: Signal[]
  top_driver: Family
  upgrade_categories: string[]
  band_thresholds: BandThresholds
  data_as_of: string
}

export interface HubComparison {
  hubs: HubScore[]
  hazards: Hazard[]
  data_as_of: string
}

export interface RankedHub {
  rank: number
  hub_id: string
  name: string
  value: number
  band: Band
}

export interface Ranking {
  kind: ScoreKind
  hazard: Hazard
  region: Region | null
  items: RankedHub[]
  band_thresholds: BandThresholds
  data_as_of: string
}

export interface WeatherStat {
  hub_id: string
  metric: Metric
  year: number
  value: number
  numerator: number
  denominator: number
  unit: string
  definition: string
  source: string
  data_as_of: string
}

export interface NwsAlert {
  event: string
  severity: string
  headline: string
  expires: string | null
}

export interface ActiveAlerts {
  hub_id: string
  alerts: NwsAlert[]
  fetched_at: string
}

export interface ScoreRow {
  hub_id: string
  name: string
  region: Region
  exposure: number
  exposure_band: Band
  priority: number
  priority_band: Band
  top_driver: Family
}

export interface ToolError {
  error: string
  retryable: boolean
  hint: string
}

export interface Figure {
  hub_id: string | null
  label: string
  value: number
  unit: string
  source_tool: string
}

export interface AgentAnswer {
  answer: string
  hubs: string[]
  ranking: string[] | null
  figures: Figure[]
  assumptions: string[]
  uncertainty: string
  data_available: boolean
  in_scope: boolean
}

export interface Grounding {
  status: 'pass' | 'retried' | 'failed'
  errors: string[]
}

export interface ChatResponse {
  session_id: string
  answer: AgentAnswer
  grounding: Grounding
  trace_id: string
}

export const TOOL_NAMES = [
  'list_hubs',
  'rank_hubs',
  'get_hub_risk',
  'compare_hubs',
  'weather_stat',
  'get_active_alerts',
  'what_if',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolError(value: unknown): value is ToolError {
  return typeof value === 'object' && value !== null && 'error' in value && 'hint' in value
}
