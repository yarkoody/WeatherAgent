// In-app Methodology view: GET /methodology.md rendered with markdown, math (KaTeX) and a table of contents.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HowScoresWork } from '../components/HowScoresWork'
import { MethodologyHost } from '../components/MethodologyHost'
import { headings, openMethodology, slugify } from '../lib/methodology'
import doc from '../mocks/methodology.md?raw'

function serve(status = 200) {
  vi.stubEnv('VITE_USE_MOCKS', '')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const path = new URL(url, 'http://test').pathname
      if (path === '/methodology.md' && status === 200) return new Response(doc, { headers: { 'Content-Type': 'text/markdown' } })
      return Response.json({ detail: 'Not Found' }, { status: 404 })
    }),
  )
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Methodology view', () => {
  it('GitHub-style anchors and a contents list from the document', () => {
    expect(slugify('1. Data sources')).toBe('1-data-sources')
    expect(slugify('2. Typical year: expected disruption days')).toBe('2-typical-year-expected-disruption-days')
    expect(headings(doc).length).toBeGreaterThan(5)
  })

  it('opens from anywhere, fetches the document, renders headings with anchors, a contents list and KaTeX math', async () => {
    serve()
    const scroll = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scroll
    render(<MethodologyHost />)
    act(() => openMethodology())
    const sheet = await screen.findByRole('dialog', { name: 'Methodology' })
    const body = await within(sheet).findByTestId('methodology-body', {}, { timeout: 5000 })
    const first = headings(doc).find((h) => h.id === '1-data-sources')!
    expect(body.querySelector(`#${CSS.escape(first.id)}`)).not.toBeNull()
    expect(body.querySelector('.katex')).not.toBeNull() // $…$ math rendered
    const toc = within(sheet).getByRole('navigation', { name: 'Methodology contents' })
    expect(within(toc).getAllByRole('link').length).toBe(headings(doc).length)
    // A link in the document's own contents scrolls inside the view.
    const link = within(body).getAllByRole('link').find((a) => a.getAttribute('href') === `#${first.id}`)!
    fireEvent.click(link)
    expect(scroll.mock.contexts).toContain(body.querySelector(`#${CSS.escape(first.id)}`))
    Element.prototype.scrollIntoView = original
  })

  it('a missing document shows a plain message', async () => {
    serve(404)
    render(<MethodologyHost />)
    act(() => openMethodology())
    expect(await screen.findByRole('alert', {}, { timeout: 5000 })).toHaveTextContent('The methodology document could not be loaded (not published yet)')
  })

  it('"How the scores work" has a Methodology entry point', async () => {
    serve()
    render(
      <>
        <MethodologyHost />
        <HowScoresWork rows={null} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Methodology: how every number is computed' }))
    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Methodology' })).toBeInTheDocument())
  })
})
