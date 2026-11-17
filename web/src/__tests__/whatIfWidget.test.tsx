// what_if in the chat: the per-$1M table with the analyst's costs, or the re-ranked list with weights only.
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { fmt, hubName } from '../lib/format'
import { toolLabel } from '../lib/toolLabels'
import type { WhatIfResult } from '../lib/types'
import whatIfJson from '../mocks/what-if.json'
import { WIDGETS } from '../widgets'
import { WhatIfWidget } from '../widgets/WhatIfWidget'

const example = whatIfJson.example as WhatIfResult
const baseline = whatIfJson.baseline as WhatIfResult

describe('what_if in the chat', () => {
  it('is registered as a chat widget', () => {
    expect(WIDGETS.what_if).toBeDefined()
  })

  it('with costs: a per-$1M table in the tool order, the leader highlighted, costs labelled as the analyst’s', () => {
    render(<WhatIfWidget data={example} />)
    const table = screen.getByRole('table', { name: 'Review priority per million dollars' })
    const rows = within(table).getAllByRole('row').slice(1)
    const pm = example.per_million_ranking!
    expect(rows).toHaveLength(pm.length)
    pm.forEach((h, i) => {
      expect(rows[i]).toHaveTextContent(hubName(h.hub_id))
      expect(rows[i]).toHaveTextContent(fmt(h.priority_per_million))
      expect(rows[i]).toHaveTextContent(fmt(h.cost_musd))
    })
    expect(rows[0].querySelector('[data-top]')).not.toBeNull()
    expect(screen.getByRole('region')).toHaveTextContent('Upgrade costs are your inputs')
    expect(screen.getByRole('region')).toHaveTextContent('not a return on investment')
  })

  it('without costs: the re-ranked review priority list', () => {
    render(<WhatIfWidget data={{ ...baseline, per_million_ranking: null }} />)
    const list = screen.getByRole('list', { name: 'Re-ranked review priority' })
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent(hubName(baseline.ranking[0].hub_id))
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('the step label names what the analyst supplied', () => {
    expect(toolLabel('what_if', { upgrade_costs: [{ hub_id: 'chicago', cost_musd: 5 }] }, true)).toBe('Re-ranked with your upgrade costs')
    expect(toolLabel('what_if', { family_weights: { winter: 0.5 } }, true)).toBe('Re-ranked with your weights')
    expect(toolLabel('what_if', { family_weights: { winter: 0.5 }, upgrade_costs: [{ hub_id: 'chicago', cost_musd: 5 }] }, true)).toBe(
      'Re-ranked with your weights and costs',
    )
  })
})
