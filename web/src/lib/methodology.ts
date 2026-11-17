// In-app Methodology view: any part of the app can open it (How the scores work, See the math, the sidebar).
// The document is GET /methodology.md (docs/METHODOLOGY.md on the backend); a mock copy serves mock mode.
export const METHODOLOGY_PATH = '/methodology.md'
const EVENT = 'methodology:open'

/** Opens the Methodology view, optionally at a section anchor (e.g. "5-review-priority"). */
export function openMethodology(anchor?: string): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(EVENT, { detail: anchor }))
}

export function onOpenMethodology(handler: (anchor?: string) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<string | undefined>).detail)
  window.addEventListener(EVENT, listener)
  return () => window.removeEventListener(EVENT, listener)
}

/** GitHub-style heading anchors, so the document's own "Contents" links work in the app. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-')
}

/** Level-2 headings for the table of contents. */
export function headings(markdown: string): { text: string; id: string }[] {
  return [...markdown.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => ({ text: m[1].replace(/[*_`]/g, ''), id: slugify(m[1].replace(/[*_`]/g, '')) }))
}
