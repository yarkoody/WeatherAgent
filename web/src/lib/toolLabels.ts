import { HAZARD_LABEL, METRIC_LABEL, hubName } from './format'
import type { Hazard, Metric, ToolName } from './types'

type Input = Record<string, unknown> | undefined

const str = (v: unknown) => (typeof v === 'string' ? v : '')

function joinNames(ids: unknown): string {
  const names = Array.isArray(ids) ? ids.map((id) => hubName(String(id))) : []
  if (names.length <= 1) return names[0] ?? 'hubs'
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function rankingPhrase(input: Input): string {
  const score = str(input?.score)
  const kind = score === 'priority' ? 'review priority' : score === 'people_impact' ? 'people-days if disrupted' : score === 'people_served' ? 'people served' : score === 'bad_year' ? 'bad-year lost days' : 'exposure'
  const hazard = str(input?.hazard) as Hazard
  const what = hazard && hazard !== 'overall' ? `${HAZARD_LABEL[hazard]?.toLowerCase() ?? hazard} ${kind}` : kind
  const region = str(input?.region)
  return region ? `${what} in the ${region}` : what
}

/** Progress chip text, written for the analyst. `done` switches to past tense. */
export function toolLabel(name: string, input: Input, done: boolean): string {
  const hub = hubName(str(input?.hub_id))
  switch (name as ToolName) {
    case 'list_hubs':
      return done ? 'Looked up the hub list' : 'Looking up the hub list'
    case 'rank_hubs':
      return done ? `Ranked hubs by ${rankingPhrase(input)}` : `Ranking hubs by ${rankingPhrase(input)}`
    case 'get_hub_risk':
      return done ? `Checked ${hub} risk` : `Checking ${hub} risk`
    case 'compare_hubs':
      return done ? `Compared ${joinNames(input?.hub_ids)}` : `Comparing ${joinNames(input?.hub_ids)}`
    case 'weather_stat': {
      const metric = METRIC_LABEL[str(input?.metric) as Metric] ?? 'weather'
      const year = input?.year ? ` in ${input.year}` : ''
      return done ? `Looked up ${hub} ${metric}${year}` : `Looking up ${hub} ${metric}${year}`
    }
    case 'get_active_alerts':
      return done ? `Checked live NWS alerts for ${hub}` : `Checking live NWS alerts for ${hub}`
    case 'what_if': {
      // Say what the analyst actually supplied: costs, weights or both.
      const costs = Array.isArray(input?.upgrade_costs) && input.upgrade_costs.length > 0
      const weights = Boolean(input?.family_weights && Object.values(input.family_weights as object).some((w) => w != null))
      const what = costs && weights ? 'your weights and costs' : costs ? 'your upgrade costs' : 'your weights'
      return done ? `Re-ranked with ${what}` : `Re-ranking with ${what}`
    }
    default:
      return done ? `Ran ${name}` : `Running ${name}`
  }
}
