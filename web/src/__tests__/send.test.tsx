// Send to Discord, Send by email, and the "Send & alerts" panel. fetch is mocked: nothing reaches Discord.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { AnswerCard } from '../components/AnswerCard'
import { SendAlertsHost } from '../components/SendAlertsPanel'
import {
  DISCORD_DESCRIPTION_MAX,
  EMAIL_BODY_MAX,
  SEND_KEY,
  discordMessage,
  isDiscordWebhook,
  loadSendSettings,
  mailtoLink,
  openSendSettings,
  plainText,
  saveSendSettings,
  truncate,
} from '../lib/send'
import type { ChatResponse } from '../lib/types'
import mock from '../mocks/chat-response.json'

const response = mock as ChatResponse
const HOOK = 'https://discord.com/api/webhooks/123/abc_DEF-1'
const QUESTION = 'Which hubs are most exposed?'

type Call = { url: string; body: Record<string, unknown> }

function stubFetch(status = 200, answer: Record<string, unknown> = { status: 'sent' }) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body ?? '{}')) })
      return Response.json(answer, { status })
    }),
  )
  return calls
}

function decodeMailto(href: string) {
  const [, rest] = href.split('mailto:')
  const [to, query] = rest.split('?')
  const params = new URLSearchParams(query)
  return { to, subject: params.get('subject') ?? '', body: params.get('body') ?? '' }
}

beforeEach(() => {
  localStorage.clear()
  vi.stubEnv('VITE_USE_MOCKS', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('webhook URL check (same rule as the backend)', () => {
  it.each([HOOK, 'https://discordapp.com/api/webhooks/1/x'])('accepts %s', (url) => expect(isDiscordWebhook(url)).toBe(true))
  it.each([
    'http://discord.com/api/webhooks/1/x',
    'https://evil.com/api/webhooks/1/x',
    'https://discord.com.evil.com/api/webhooks/1/x',
    'https://discord.com:8443/api/webhooks/1/x',
    'https://1.2.3.4/api/webhooks/1/x',
    'https://discord.com/api/channels/1/x',
    'https://discord.com/api/webhooks/1/x?wait=true',
  ])('rejects %s', (url) => expect(isDiscordWebhook(url)).toBe(false))

  it('drops a stored URL that is not a Discord webhook', () => {
    localStorage.setItem(SEND_KEY, JSON.stringify({ discordWebhook: 'https://evil.com/x', email: 'a@b.co', alerts: true }))
    expect(loadSendSettings()).toEqual({ discordWebhook: '', email: 'a@b.co', alerts: true })
  })
})

describe('message building', () => {
  it('truncates with an ellipsis at the exact limit', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('abc', 4)).toBe('abc')
  })

  it('builds the Discord message: question, answer, figures, status, data date, link', () => {
    const m = discordMessage(response, QUESTION, '2025-12-31')
    expect(m.title).toBe(QUESTION)
    expect(m.description).toBe(response.answer.answer)
    expect(m.fields.length).toBe(Math.min(response.answer.figures.length, 8))
    expect(m.footer).toContain('Figures checked')
    expect(m.footer).toContain('Data as of Dec 31, 2025')
    expect(m.link).toBe(`${window.location.origin}/`)
    expect(m.verified).toBe(true)
  })

  it('marks an unverified answer and cuts a long one to 4,096 characters', () => {
    const long = { ...response, grounding: { status: 'failed', errors: [] }, answer: { ...response.answer, answer: 'x'.repeat(9000) } } as ChatResponse
    const m = discordMessage(long, QUESTION)
    expect(m.verified).toBe(false)
    expect(m.footer).toContain('Unverified')
    expect(m.description).toHaveLength(DISCORD_DESCRIPTION_MAX)
  })

  it('builds a mailto link with the question as subject and a short plain-text body', () => {
    const { to, subject, body } = decodeMailto(mailtoLink(response, QUESTION, '2025-12-31', 'team@example.com'))
    expect(to).toBe('team@example.com')
    expect(subject).toBe(`Hub Weather Risk: ${QUESTION}`)
    expect(body).toContain(`Question: ${QUESTION}`)
    expect(body).toContain('Key figures:')
    expect(body).toContain('Figures checked. Data as of Dec 31, 2025')
    expect(body).toContain(`Hub Weather Risk: ${window.location.origin}/`)
    expect(body).not.toMatch(/\*\*/)
  })

  it('keeps the email body under the limit and still ends with the app link', () => {
    const long = { ...response, answer: { ...response.answer, answer: 'word '.repeat(2000) } } as ChatResponse
    const { to, body } = decodeMailto(mailtoLink(long, QUESTION, undefined, 'not an email'))
    expect(to).toBe('')
    expect(body.length).toBeLessThanOrEqual(EMAIL_BODY_MAX)
    expect(body).toContain('…')
    expect(body.trimEnd().endsWith(`${window.location.origin}/`)).toBe(true)
  })

  it('turns markdown into plain text', () => {
    expect(plainText('## Title\n**Miami** leads, see [docs](https://x.test).')).toBe('Title\nMiami leads, see docs (https://x.test).')
  })
})

describe('buttons on the answer', () => {
  it('sit next to Export report', () => {
    render(<AnswerCard response={response} question={QUESTION} />)
    const footer = screen.getByRole('button', { name: /Export report/ }).parentElement!
    expect(within(footer).getByRole('button', { name: /Send to Discord/ })).toBeInTheDocument()
    expect(within(footer).getByRole('link', { name: /Send by email/ })).toHaveAttribute('href', expect.stringMatching(/^mailto:\?subject=/))
  })

  it('open the Send & alerts panel when no webhook is set, without calling the server', async () => {
    const calls = stubFetch()
    render(
      <>
        <SendAlertsHost />
        <AnswerCard response={response} question={QUESTION} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Send to Discord/ }))
    expect(await screen.findByRole('dialog', { name: 'Send & alerts' })).toBeInTheDocument()
    expect(calls).toEqual([])
  })

  it('post the answer to /send/discord with the saved webhook', async () => {
    saveSendSettings({ discordWebhook: HOOK, email: 'me@example.com' })
    const calls = stubFetch()
    render(<AnswerCard response={response} question={QUESTION} dataAsOf="2025-12-31" />)
    expect(screen.getByRole('link', { name: /Send by email/ })).toHaveAttribute('href', expect.stringMatching(/^mailto:me@example\.com\?/))
    fireEvent.click(screen.getByRole('button', { name: /Send to Discord/ }))
    expect(await screen.findByRole('button', { name: /Sent to Discord/ })).toBeInTheDocument()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/send/discord')
    expect(calls[0].body).toMatchObject({ webhook_url: HOOK, title: QUESTION, verified: true })
  })

  it('show the server error with a way to the panel when Discord does not know the webhook', async () => {
    saveSendSettings({ discordWebhook: HOOK })
    stubFetch(404, { detail: 'Discord does not know this webhook.' })
    render(
      <>
        <SendAlertsHost />
        <AnswerCard response={response} question={QUESTION} />
      </>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Send to Discord/ }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Discord does not know this webhook.')
    fireEvent.click(within(alert).getByRole('button', { name: 'Open Send & alerts' }))
    expect(await screen.findByRole('dialog', { name: 'Send & alerts' })).toBeInTheDocument()
  })
})

describe('Send & alerts panel', () => {
  const openPanel = async () => {
    render(<SendAlertsHost />)
    openSendSettings()
    return screen.findByRole('dialog', { name: 'Send & alerts' })
  }

  it('saves a valid webhook and refuses others', async () => {
    const panel = await openPanel()
    const input = within(panel).getByLabelText('Webhook URL')
    fireEvent.change(input, { target: { value: 'https://evil.com/api/webhooks/1/x' } })
    expect(within(panel).getByText(/Paste a Discord webhook URL/)).toBeInTheDocument()
    expect(loadSendSettings().discordWebhook).toBe('')
    expect(within(panel).getByRole('button', { name: 'Send test message' })).toBeDisabled()
    fireEvent.change(input, { target: { value: HOOK } })
    expect(loadSendSettings().discordWebhook).toBe(HOOK)
    expect(within(panel).getByRole('button', { name: 'Send test message' })).toBeEnabled()
  })

  it('sends a test message', async () => {
    saveSendSettings({ discordWebhook: HOOK })
    const calls = stubFetch()
    const panel = await openPanel()
    fireEvent.click(within(panel).getByRole('button', { name: 'Send test message' }))
    expect(await within(panel).findByText(/Test message sent/)).toBeInTheDocument()
    expect(calls[0]).toMatchObject({ url: '/send/discord', body: { webhook_url: HOOK, title: 'Test message from Hub Weather Risk' } })
  })

  it('saves a default email address', async () => {
    const panel = await openPanel()
    fireEvent.change(within(panel).getByLabelText(/Default address/), { target: { value: 'ops@example.com' } })
    expect(loadSendSettings().email).toBe('ops@example.com')
  })

  it('subscribes and unsubscribes to score-change alerts, and says what the limits are', async () => {
    saveSendSettings({ discordWebhook: HOOK })
    const calls = stubFetch(200, { status: 'subscribed' })
    const panel = await openPanel()
    expect(within(panel).getByText(/forgets subscriptions when it is redeployed/)).toBeInTheDocument()
    const toggle = within(panel).getByRole('switch', { name: /Alert me when a hub's score changes/ })
    fireEvent.click(toggle)
    expect(await within(panel).findByText(/Subscribed\. A confirmation was posted/)).toBeInTheDocument()
    expect(calls[0]).toEqual({ url: '/alerts/subscribe', body: { webhook_url: HOOK } })
    expect(loadSendSettings().alerts).toBe(true)
    fireEvent.click(within(panel).getByRole('switch', { name: /Alert me/ }))
    await waitFor(() => expect(loadSendSettings().alerts).toBe(false))
    expect(calls[1]).toEqual({ url: '/alerts/unsubscribe', body: { webhook_url: HOOK } })
  })

  it('keeps the alert switch off when the server refuses', async () => {
    saveSendSettings({ discordWebhook: HOOK })
    stubFetch(409, { detail: 'This demo already has the maximum number of alert subscriptions.' })
    const panel = await openPanel()
    fireEvent.click(within(panel).getByRole('switch', { name: /Alert me/ }))
    expect(await within(panel).findByText(/maximum number of alert subscriptions/)).toBeInTheDocument()
    expect(loadSendSettings().alerts).toBe(false)
  })

  it('cannot turn alerts on without a webhook', async () => {
    const panel = await openPanel()
    const toggle = within(panel).getByRole('switch', { name: /Alert me/ })
    expect(toggle).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('sidebar', () => {
  it('has "Send & alerts" above Methodology, and it opens the panel', async () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
    render(<App />)
    const send = screen.getByRole('button', { name: 'Send & alerts' })
    const methodology = screen.getByRole('button', { name: 'Methodology' })
    expect(send.compareDocumentPosition(methodology) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Settings has no copy of these controls.
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(settings).queryByLabelText('Webhook URL')).toBeNull()
    fireEvent.keyDown(settings, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Send & alerts' }))
    expect(await screen.findByRole('dialog', { name: 'Send & alerts' })).toBeInTheDocument()
  })
})
