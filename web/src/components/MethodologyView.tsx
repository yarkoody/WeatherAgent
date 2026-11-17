// The methodology document (GET /methodology.md) rendered with react-markdown + remark-math + rehype-katex,
// with a table of contents from its sections. Lazy-loaded with KaTeX's CSS.
import 'katex/dist/katex.min.css'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { Skeleton } from '@/components/ui/skeleton'
import { METHODOLOGY_PATH, headings, slugify } from '@/lib/methodology'
import { apiFetch } from '@/lib/mockFetch'

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node && typeof node === 'object' && 'props' in node) return textOf((node as { props: { children?: ReactNode } }).props.children)
  return ''
}

export function MethodologyView({ anchor }: { anchor?: string }) {
  const [state, setState] = useState<{ md?: string; error?: string } | null>(null)
  const body = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ctl = new AbortController()
    apiFetch(METHODOLOGY_PATH, { signal: ctl.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(r.status === 404 ? 'not published yet' : `HTTP ${r.status}`)
        return r.text()
      })
      .then((md) => setState({ md }))
      .catch((e: Error) => e.name !== 'AbortError' && setState({ error: e.message }))
    return () => ctl.abort()
  }, [])

  const go = (id: string) => body.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView?.({ block: 'start' })
  useEffect(() => {
    if (state?.md && anchor) go(anchor)
  }, [state?.md, anchor])

  if (state?.error)
    return (
      <p role="alert" className="m-5 rounded-2xl bg-muted px-4 py-3 text-sm text-muted-foreground">
        The methodology document could not be loaded ({state.error}). The "See the math" section in each hub breakdown shows the calculation.
      </p>
    )
  if (!state?.md)
    return (
      <div role="status" aria-label="Loading the methodology" className="space-y-3 p-5">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-40 w-full rounded-2xl" />
      </div>
    )

  const toc = headings(state.md)
  const heading =
    (Tag: 'h1' | 'h2' | 'h3' | 'h4') =>
    ({ children }: { children?: ReactNode }) => (
      <Tag id={slugify(textOf(children))} className="scroll-mt-4">
        {children}
      </Tag>
    )
  return (
    <div className="grid h-[calc(100dvh-5.5rem)] min-h-0 md:grid-cols-[13rem_minmax(0,1fr)]">
      <nav aria-label="Methodology contents" className="hidden overflow-y-auto border-r border-border/60 p-4 text-sm md:block">
        <ol className="space-y-1.5">
          {toc.map((h) => (
            <li key={h.id}>
              <a href={`#${h.id}`} onClick={(e) => (e.preventDefault(), go(h.id))} className="text-muted-foreground hover:text-foreground">
                {h.text}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <div
        ref={body}
        data-testid="methodology-body"
        className="prose-answer methodology overflow-y-auto px-5 py-4 text-sm"
        onClick={(e) => {
          // The document's own "#section" links scroll inside the view.
          const a = (e.target as HTMLElement).closest('a')
          const href = a?.getAttribute('href')
          if (href?.startsWith('#')) {
            e.preventDefault()
            go(href.slice(1))
          }
        }}
      >
        <ReactMarkdown
          remarkPlugins={[remarkGfm, remarkMath]}
          rehypePlugins={[rehypeKatex]}
          components={{
            h1: heading('h1'),
            h2: heading('h2'),
            h3: heading('h3'),
            h4: heading('h4'),
            a: ({ href, children }) =>
              href?.startsWith('#') ? <a href={href}>{children}</a> : <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          }}
        >
          {state.md}
        </ReactMarkdown>
      </div>
    </div>
  )
}
