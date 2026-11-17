// Data provenance: one short line per source with its period or vintage. Nothing is hard-coded in the UI.
// Until the backend endpoint exists, mock mode serves src/mocks/provenance.json (marked as a placeholder) and the
// live app shows nothing. When the endpoint ships, set PROVENANCE_ENDPOINT.
import { useEffect, useState } from 'react'
import { USE_MOCKS, apiFetch } from './mockFetch'

export interface ProvenanceSource {
  name: string
  detail: string
}
export interface Provenance {
  sources: ProvenanceSource[]
  /** True for the mock until the real endpoint is wired. */
  placeholder?: boolean
}

/** The backend route for provenance, once it exists (null until then). */
export const PROVENANCE_ENDPOINT: string | null = null

export async function loadProvenance(signal?: AbortSignal): Promise<Provenance | null> {
  if (PROVENANCE_ENDPOINT && !USE_MOCKS) {
    const r = await apiFetch(PROVENANCE_ENDPOINT, { signal })
    return r.ok ? ((await r.json()) as Provenance) : null
  }
  if (USE_MOCKS) return (await import('../mocks/provenance.json')).default as Provenance
  return null
}

export function useProvenance(): Provenance | null {
  const [data, setData] = useState<Provenance | null>(null)
  useEffect(() => {
    const ctl = new AbortController()
    loadProvenance(ctl.signal)
      .then((p) => !ctl.signal.aborted && setData(p))
      .catch(() => {})
    return () => ctl.abort()
  }, [])
  return data
}

/** "FEMA National Risk Index: county event frequencies …" lines, for print and CSV. */
export function provenanceLines(p: Provenance | null): string[] {
  return p ? p.sources.map((s) => `${s.name}: ${s.detail}`) : []
}
