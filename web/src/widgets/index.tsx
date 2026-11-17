// Generative UI: the model picks a tool, and the UI draws that tool's deterministic output.
// Widgets never read model text, so a chart cannot show a number no tool returned.
// Each widget is lazy-loaded, so Recharts stays out of the first page load; a stale chunk after a deploy reloads the page once.
import type { ComponentType } from 'react'
import { lazyWithReload as lazy } from '@/lib/chunkReload'
import type { ToolName } from '@/lib/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Widget = ComponentType<{ data: any }>

export const WIDGETS: Partial<Record<ToolName, Widget>> = {
  rank_hubs: lazy(() => import('./RankingWidget').then((m) => ({ default: m.RankingWidget }))),
  get_hub_risk: lazy(() => import('./HubBreakdown').then((m) => ({ default: m.HubBreakdown }))),
  compare_hubs: lazy(() => import('./ComparisonCards').then((m) => ({ default: m.ComparisonCards }))),
  weather_stat: lazy(() => import('./WeatherStatRing').then((m) => ({ default: m.WeatherStatRing }))),
  get_active_alerts: lazy(() => import('./AlertBanner').then((m) => ({ default: m.AlertBanner }))),
  get_hub_history: lazy(() => import('./HistoryWidget').then((m) => ({ default: m.HistoryWidget }))),
  // The what-if result in the chat; the sliders to change it live on the Scores page. list_hubs has no widget on purpose.
  what_if: lazy(() => import('./WhatIfWidget').then((m) => ({ default: m.WhatIfWidget }))),
}
