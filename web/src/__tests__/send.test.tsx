// "Send & alerts": score-change alerts to Discord or email, set up from the sidebar. fetch is mocked: nothing is sent.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { AnswerCard } from '../components/AnswerCard'
import { SendAlertsHost } from '../components/SendAlertsPanel'
import { SEND_KEY, isDiscordWebhook, isEmail, loadSendSettings, openSendSettings, saveSendSettings } from '../lib/send'
import type { ChatResponse } from '../lib/types'
import mock from '../mocks/chat-response.json'

const HOOK = 'https://discord.com/api/webhooks/123/abc_DEF-1'

type Call = { method: string; url: string; body: Record<string, unknown> | null }

/** fetch stub: GET /alerts/config says whether email is on; POSTs answer `status` with `answer`. */
function stubFetch({ email = false, status = 200, answer = { status: 'subscribed' } as Record<string, unknown> } = {}) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/alerts/config') return Response.json({ discord: true, email })
      calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null })
      return Response.json(answer, { status })
    }),
  )
  return calls
}

const openPanel = async () => {
  render(<SendAlertsHost />)
  openSendSettings()
  return screen.findByRole('dialog', { name: 'Send & alerts' })
}

beforeEach(() => {
  localStorage.clear()
  vi.stubEnv('VITE_USE_MOCKS', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('input checks (same rules as the backend)', () => {
  it.each([HOOK, 'https://discordapp.com/api/webhooks/1/x'])('accepts the webhook %s', (url) => expect(isDiscordWebhook(url)).toBe(true))
  it.each([
    'http://discord.com/api/webhooks/1/x',
    'https://evil.com/api/webhooks/1/x',
    'https://discord.com.evil.com/api/webhooks/1/x',
    'https://discord.com:8443/api/webhooks/1/x',
    'https://1.2.3.4/api/webhooks/1/x',
    'https://discord.com/api/channels/1/x',
    'https://discord.com/api/webhooks/1/x?wait=true',
  ])('rejects the webhook %s', (url) => expect(isDiscordWebhook(url)).toBe(false))

  it.each(['ops@example.com', 'a.b+c@sub.example.co.uk'])('accepts the address %s', (a) => expect(isEmail(a)).toBe(true))
  it.each(['ops', 'ops@example', 'a@b.c', 'a@b.com, c@d.com', 'a@b.com\nBcc: x@y.com'])('rejects the address %j', (a) =>
    expect(isEmail(a)).toBe(false),
  )

  it('drops stored values that fail the checks', () => {
    localStorage.setItem(SEND_KEY, JSON.stringify({ discordWebhook: 'https://evil.com/x', discordAlerts: true, email: 'nope', emailAlerts: true }))
    expect(loadSendSettings()).toEqual({ discordWebhook: '', discordAlerts: false, email: '', emailAlerts: false })
  })
})

describe('answers', () => {
  it('have no send buttons: only Export report', () => {
    render(<AnswerCard response={mock as ChatResponse} question="Which hubs are most exposed?" />)
    expect(screen.getByRole('button', { name: /Export report/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Discord/ })).toBeNull()
    expect(screen.queryByRole('link', { name: /email/i })).toBeNull()
  })
})

describe('Discord alerts', () => {
  it('saves a valid webhook and refuses others', async () => {
    stubFetch()
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

  it('sends a test message with only the webhook URL', async () => {
    saveSendSettings({ discordWebhook: HOOK })
    const calls = stubFetch({ answer: { status: 'sent' } })
    const panel = await openPanel()
    fireEvent.click(within(panel).getByRole('button', { name: 'Send test message' }))
    expect(await within(panel).findByText(/Test message sent/)).toBeInTheDocument()
    expect(calls).toEqual([{ method: 'POST', url: '/send/discord', body: { webhook_url: HOOK } }])
  })

  it('subscribes and unsubscribes', async () => {
    saveSendSettings({ discordWebhook: HOOK })
    const calls = stubFetch()
    const panel = await openPanel()
    fireEvent.click(within(panel).getByRole('switch', { name: /Alert this channel/ }))
    expect(await within(panel).findByText(/Subscribed\. A confirmation was posted/)).toBeInTheDocument()
    expect(calls[0]).toEqual({ method: 'POST', url: '/alerts/subscribe', body: { webhook_url: HOOK } })
    expect(loadSendSettings().discordAlerts).toBe(true)
    fireEvent.click(within(panel).getByRole('switch', { name: /Alert this channel/ }))
    await waitFor(() => expect(loadSendSettings().discordAlerts).toBe(false))
    expect(calls[1]).toEqual({ method: 'POST', url: '/alerts/unsubscribe', body: { webhook_url: HOOK } })
  })

  it('keeps the switch off when the server refuses', async () => {
    saveSendSettings({ discordWebhook: HOOK })
    stubFetch({ status: 409, answer: { detail: 'This demo already has the maximum number of discord alert subscriptions.' } })
    const panel = await openPanel()
    fireEvent.click(within(panel).getByRole('switch', { name: /Alert this channel/ }))
    expect(await within(panel).findByText(/maximum number/)).toBeInTheDocument()
    expect(loadSendSettings().discordAlerts).toBe(false)
  })

  it('a new webhook ends the old subscription', async () => {
    saveSendSettings({ discordWebhook: HOOK, discordAlerts: true })
    const calls = stubFetch()
    const panel = await openPanel()
    fireEvent.change(within(panel).getByLabelText('Webhook URL'), { target: { value: 'https://discord.com/api/webhooks/9/new' } })
    expect(within(panel).getByText(/Alerts were turned off because the webhook changed/)).toBeInTheDocument()
    expect(calls[0]).toEqual({ method: 'POST', url: '/alerts/unsubscribe', body: { webhook_url: HOOK } })
    expect(loadSendSettings()).toMatchObject({ discordWebhook: 'https://discord.com/api/webhooks/9/new', discordAlerts: false })
  })

  it('cannot be turned on without a webhook', async () => {
    stubFetch()
    const panel = await openPanel()
    expect(within(panel).getByRole('switch', { name: /Alert this channel/ })).toHaveAttribute('aria-disabled', 'true')
  })
})

describe('email alerts', () => {
  it('are disabled, with the reason, when the server has no email provider', async () => {
    stubFetch({ email: false })
    const panel = await openPanel()
    expect(await within(panel).findByText('Email alerts need an email provider configured on the server.')).toBeInTheDocument()
    expect(within(panel).getByLabelText('Email address')).toBeDisabled()
    expect(within(panel).getByRole('switch', { name: /Email me/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('subscribe an address when the server can send email', async () => {
    const calls = stubFetch({ email: true })
    const panel = await openPanel()
    const input = within(panel).getByLabelText('Email address')
    await waitFor(() => expect(input).toBeEnabled())
    fireEvent.change(input, { target: { value: 'not an email' } })
    expect(within(panel).getByText(/does not look like an email address/)).toBeInTheDocument()
    fireEvent.change(input, { target: { value: 'ops@example.com' } })
    fireEvent.click(within(panel).getByRole('switch', { name: /Email me/ }))
    expect(await within(panel).findByText(/Subscribed\. A confirmation email is on its way/)).toBeInTheDocument()
    expect(calls).toEqual([{ method: 'POST', url: '/alerts/subscribe', body: { email: 'ops@example.com' } }])
    expect(loadSendSettings()).toMatchObject({ email: 'ops@example.com', emailAlerts: true })
  })
})

describe('sidebar', () => {
  it('has "Send & alerts" above Methodology; Settings has no copy of these controls', async () => {
    stubFetch()
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }))
    render(<App />)
    const send = screen.getByRole('button', { name: 'Send & alerts' })
    const methodology = screen.getByRole('button', { name: 'Methodology' })
    expect(send.compareDocumentPosition(methodology) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
    const settings = await screen.findByRole('dialog', { name: 'Settings' })
    expect(within(settings).queryByLabelText('Webhook URL')).toBeNull()
    fireEvent.keyDown(settings, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Settings' })).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Send & alerts' }))
    expect(await screen.findByRole('dialog', { name: 'Send & alerts' })).toBeInTheDocument()
  })
})
