import { ExternalLinkIcon, GlobeIcon } from 'lucide-react'
import { formatDate, formatDateTime } from '@/lib/format'
import { safeHref } from '@/lib/links'
import { WEB_LABEL, type WebSearchResult } from '@/lib/types'

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

/** The web_search tool's results: linked sources, always labeled as web content, never as scoring data. */
export function WebSources({ data }: { data: WebSearchResult }) {
  const results = data?.results ?? []
  if (results.length === 0) return null
  return (
    <section className="w-full rounded-xl bg-muted/40 ring-1 ring-border" aria-label="Web sources">
      <div className="flex flex-wrap items-center gap-2 px-5 pt-3.5 text-sm font-semibold">
        <GlobeIcon className="size-4 text-isobar" aria-hidden="true" />
        Web sources
        <span className="rounded-full bg-band-medium-soft px-2 py-0.5 text-[0.7rem] font-medium text-band-medium-text">{WEB_LABEL}</span>
      </div>
      <ul className="divide-y divide-border/60">
        {results.map((r) => {
          const href = safeHref(r.url)
          return (
            <li key={r.url} className="px-5 py-2.5 text-sm">
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-start gap-1 font-medium text-isobar underline-offset-2 hover:underline">
                  <span>{r.title}</span>
                  <ExternalLinkIcon className="mt-1 size-3 shrink-0" aria-hidden="true" />
                </a>
              ) : (
                <span className="font-medium">{r.title}</span>
              )}
              <p className="text-xs text-muted-foreground">
                {host(r.url)}
                {r.published ? ` · ${formatDate(r.published)}` : ''}
              </p>
              {r.snippet && <p className="mt-1 text-muted-foreground">{r.snippet}</p>}
            </li>
          )
        })}
      </ul>
      <p className="px-5 pb-3.5 text-[0.7rem] text-muted-foreground">
        Third-party reports found by web search on {formatDateTime(data.searched_at)}. They are not checked against our data and never change a score.
      </p>
    </section>
  )
}
