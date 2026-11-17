// One "How to read this" (i) per widget, in its title row: the terms and cut-offs, plus the hub's own calculation on request.
import { InfoTip } from '@/components/InfoTip'
import type { LegendEntry } from '@/lib/explain'

export function ReadingGuide({ legend, steps, detail }: { legend: LegendEntry[]; steps?: string[]; detail?: string[] }) {
  return <InfoTip subject="this" title="How to read this" legend={legend} steps={steps} detail={detail} />
}
