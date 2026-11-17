import { apiFetch } from './mockFetch'
import type { SecondOpinion } from './types'

/** The last offline JEV cross-check, or null when there is none (404) or it cannot be read: the UI then hides it. */
export async function fetchSecondOpinion(signal?: AbortSignal): Promise<SecondOpinion | null> {
  try {
    const res = await apiFetch('/second-opinion', { signal })
    return res.ok ? ((await res.json()) as SecondOpinion) : null
  } catch {
    return null
  }
}

export type RerunResult = { ok: true; opinion: SecondOpinion } | { ok: false; detail: string }

/** Developer view only. The server allows it only when running locally (503 elsewhere). */
export async function rerunSecondOpinion(): Promise<RerunResult> {
  try {
    const res = await apiFetch('/second-opinion/rerun', { method: 'POST' })
    if (res.ok) return { ok: true, opinion: (await res.json()) as SecondOpinion }
    const body = (await res.json().catch(() => null)) as { detail?: string } | null
    return { ok: false, detail: body?.detail ?? `Re-run failed (HTTP ${res.status}).` }
  } catch {
    return { ok: false, detail: 'The server did not respond. Check that the backend is running.' }
  }
}
