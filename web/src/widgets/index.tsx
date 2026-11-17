// Generative UI: the model picks a tool, and the UI draws that tool's deterministic output.
// Widgets never read model text, so a chart cannot show a number no tool returned.
import type { ComponentType } from 'react'
import type { ToolName } from '../lib/types'
import { AlertBanner } from './AlertBanner'
import { ComparisonCards } from './ComparisonCards'
import { HubBreakdown } from './HubBreakdown'
import { RankingWidget } from './RankingWidget'
import { WeatherStatRing } from './WeatherStatRing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Widget = ComponentType<{ data: any }>

export const WIDGETS: Partial<Record<ToolName, Widget>> = {
  rank_hubs: RankingWidget,
  get_hub_risk: HubBreakdown,
  compare_hubs: ComparisonCards,
  weather_stat: WeatherStatRing,
  get_active_alerts: AlertBanner,
  // Tier 2 (later): what_if -> WhatIfRanking (renders WhatIfResult). list_hubs has no widget on purpose.
}
