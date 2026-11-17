// "Data sources": one short line per source with its period or vintage, from useProvenance (no hard-coded text).
import { useProvenance, type Provenance } from '@/lib/provenance'

export function DataSources({ provenance, className }: { provenance?: Provenance | null; className?: string }) {
  const loaded = useProvenance()
  const p = provenance === undefined ? loaded : provenance
  if (!p || p.sources.length === 0) return null
  return (
    <section aria-label="Data sources" className={className}>
      <h3 className="text-xs font-semibold text-foreground">
        Data sources{p.placeholder && <span className="ml-1 font-normal text-muted-foreground">(placeholder until the provenance endpoint lands)</span>}
      </h3>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
        {p.sources.map((s) => (
          <li key={s.name}>
            <span className="text-foreground">{s.name}</span>: {s.detail}
          </li>
        ))}
      </ul>
    </section>
  )
}
