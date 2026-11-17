// TypeScript mirrors of app/schemas.py (the source of truth). Keep field names identical.

export type Region = 'Midwest' | 'South' | 'West' | 'Northeast'
export type Family = 'winter' | 'flood' | 'hurricane' | 'severe_storm'
export type Hazard = 'overall' | Family
export type ScoreKind = 'exposure' | 'priority' | 'bad_year' // bad_year = 1-in-20-year disruption days
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
  band: Band // by days (medium from 2, high from 5); hurricane by 10-year probability
  /** This family's share of the hub's bad year (the four sum to HubScore.bad_year_days). Missing in older data. */
  bad_year_days?: number
  signals: Signal[]
}

export interface BandThresholds {
  medium_from: number // index value where "medium" starts (35)
  high_from: number // index value where "high" starts (60)
  days_cap: number // disruption days per year that map to index 100 (25)
  medium_from_days: number // the medium cut-off in days per year (8.75)
  high_from_days: number // the high cut-off in days per year (15)
  family_medium_from_days: number // a hazard family is "medium" from this many days per year (2)
  family_high_from_days: number // (5)
  hurricane_medium_from_pct: number // hurricane family band by 10-year probability (20)
  hurricane_high_from_pct: number // (50)
}

export interface HubScore {
  hub_id: string
  exposure: number
  exposure_days_per_year: number // typical year
  bad_year_days: number // average lost days in the worst 1 in 20 years (TVaR95)
  hurricane_10yr_probability_pct: number // chance of at least one hurricane-class event in 10 years, 0-100
  exposure_band: Band
  families: Record<Family, FamilyScore>
  family_weights: Record<Family, number> // each family's share of total days, percent
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
  band: Band | null // null for kind "bad_year": no band on the tail lens
}

export interface Ranking {
  kind: ScoreKind
  hazard: Hazard
  region: Region | null
  items: RankedHub[]
  band_thresholds: BandThresholds
  data_as_of: string
  /** Hubs that matched the filter before top_n (0 or missing from older backends: unknown). */
  total?: number
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

export interface YearDays {
  year: number
  days: Record<Family, number> // observed disruption days that year (hurricane is not observed: 0)
  total: number
}

export interface MonthDays {
  month: number // 1-12
  days: Record<Family, number> // average observed disruption days in that month
  total: number
}

/** Observed weather history at the hub point: variability by year and seasonality by month. */
export interface HubHistory {
  hub_id: string
  name: string
  start_year: number
  end_year: number
  years: YearDays[]
  months: MonthDays[]
  worst_year: number
  peak_months: number[]
  thresholds: Record<string, string>
  note: string
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
  exposure_days_per_year: number
  bad_year_days: number
  hurricane_10yr_probability_pct: number
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
  source_field?: string // exact field in that tool's result (optional: older answers and saved chats lack it)
  family?: Family | null // set when the field sits inside a hazard family (families.<family>.<field>)
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
  /** Suggested next questions (0-3), built by code from the turn. Missing in answers saved before this field. */
  follow_ups?: string[]
}

export const TOOL_NAMES = [
  'list_hubs',
  'rank_hubs',
  'get_hub_risk',
  'compare_hubs',
  'weather_stat',
  'get_active_alerts',
  'what_if',
  'get_hub_history',
] as const
export type ToolName = (typeof TOOL_NAMES)[number]

export function isToolError(value: unknown): value is ToolError {
  return typeof value === 'object' && value !== null && 'error' in value && 'hint' in value
}

// ---------- what-if (analyst-supplied weights and costs; POST /what-if) ----------

export interface FamilyWeights {
  winter?: number | null
  flood?: number | null
  hurricane?: number | null
  severe_storm?: number | null
}

export interface HubCost {
  hub_id: string
  cost_musd: number // 0.1-1000
}

export interface WhatIfInput {
  family_weights?: FamilyWeights | null
  upgrade_costs?: HubCost[] | null
}

export interface PerMillionHub {
  rank: number
  hub_id: string
  name: string
  priority: number
  cost_musd: number
  priority_per_million: number
}

export interface WhatIfResult {
  kind: ScoreKind
  inputs_echo: WhatIfInput
  ranking: RankedHub[]
  per_million_ranking: PerMillionHub[] | null
  note: string
  data_as_of: string
}
