// One hub's JEV second opinion: a four-square strip in the fixed family order (winter, flood, hurricane,
// severe storm) plus "3/4". Click or tap opens each family's formula band against JEV's band and score.
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { FAMILIES, FAMILY_LABEL, shortHubName } from '@/lib/format'
import type { JevHubOpinion } from '@/lib/types'
import { BandPill } from '@/widgets/WidgetFrame'

export function SecondOpinionCell({ hub }: { hub: JevHubOpinion }) {
  const byFamily = new Map(hub.families.map((f) => [f.family, f]))
  const disagrees = hub.agree_count < hub.total
  const name = shortHubName(hub.name)

  return (
    <Popover>
      <PopoverTrigger
        data-disagrees={disagrees}
        aria-label={`JEV second opinion for ${name}: ${hub.agree_count} of ${hub.total} agree`}
        className={`inline-flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/30 ${
          disagrees ? 'font-semibold text-[#9b2f2a]' : 'text-muted-foreground'
        }`}
      >
        {/* The strip hides on small screens; the count stays as a compact badge. */}
        <span className="hidden gap-0.5 sm:flex" aria-hidden="true">
          {FAMILIES.map((f) => {
            const o = byFamily.get(f)
            if (!o) return <span key={f} className="size-2.5 rounded-[3px] bg-muted" />
            return o.agrees ? (
              <span key={f} className="size-2.5 rounded-[3px] bg-band-low" />
            ) : (
              <span key={f} className="relative size-2.5 overflow-hidden rounded-[3px] ring-[1.5px] ring-band-high ring-inset">
                <span className="absolute top-1/2 left-1/2 h-[1.5px] w-4 -translate-x-1/2 -translate-y-1/2 -rotate-45 bg-band-high" />
              </span>
            )
          })}
        </span>
        <span className={`tabular-nums ${disagrees ? 'max-sm:rounded-md max-sm:px-1.5 max-sm:ring-1 max-sm:ring-band-high/50' : ''}`}>
          {hub.agree_count}/{hub.total}
          <span className="hidden sm:inline"> agree</span>
        </span>
      </PopoverTrigger>
      <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] gap-2 text-sm">
        <p className="font-medium">
          {name}: JEV agrees on {hub.agree_count} of {hub.total} hazard ratings
        </p>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th scope="col" className="py-1 font-medium">Hazard</th>
              <th scope="col" className="py-1 font-medium">Formula</th>
              <th scope="col" className="py-1 font-medium">JEV</th>
            </tr>
          </thead>
          <tbody>
            {FAMILIES.map((f) => {
              const o = byFamily.get(f)
              if (!o) return null
              return (
                <tr key={f} data-agrees={o.agrees} className={`border-t ${o.agrees ? '' : 'bg-band-high-soft/60'}`}>
                  <th scope="row" className="py-1.5 pr-2 text-left font-medium">
                    {FAMILY_LABEL[f]}
                    {!o.agrees && <span className="ml-1.5 text-[0.7rem] font-semibold text-[#9b2f2a]">differs</span>}
                  </th>
                  <td className="py-1.5 pr-2">
                    <BandPill band={o.our_band} />
                  </td>
                  <td className="py-1.5">
                    <span className="inline-flex items-center gap-1.5">
                      <BandPill band={o.jev_band} />
                      <span className="text-muted-foreground tabular-nums">{o.jev_score_pct}%</span>
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="text-xs text-muted-foreground">JEV's score is mapped to bands with the same cut-offs as the formula's index.</p>
      </PopoverContent>
    </Popover>
  )
}
