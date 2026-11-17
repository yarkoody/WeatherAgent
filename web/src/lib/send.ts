// Send an answer to Discord or by email, and the "Send & alerts" settings they use.
// Settings live in this browser only (localStorage), like the chat history. Discord posts go through the backend
// (POST /send/discord), which accepts Discord webhook URLs only. Email is a mailto: link: this site never sends email.
import { formatDate, formatValue, hubName } from './format'
import { apiFetch } from './mockFetch'
import type { ChatResponse } from './types'

export const SEND_KEY = 'weather-risk.send.v1'
const OPEN_EVENT = 'send-settings:open'
const CHANGE_EVENT = 'send-settings:change'

export interface SendSettings {
  discordWebhook: string
  email: string
  /** This browser subscribed its webhook to score-change alerts (the server keeps the subscription). */
  alerts: boolean
}

const EMPTY: SendSettings = { discordWebhook: '', email: '', alerts: false }

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function loadSendSettings(): SendSettings {
  try {
    const raw = JSON.parse(storage()?.getItem(SEND_KEY) ?? 'null') as Partial<SendSettings> | null
    if (!raw || typeof raw !== 'object') return { ...EMPTY }
    return {
      discordWebhook: typeof raw.discordWebhook === 'string' && isDiscordWebhook(raw.discordWebhook) ? raw.discordWebhook : '',
      email: typeof raw.email === 'string' ? raw.email : '',
      alerts: raw.alerts === true,
    }
  } catch {
    return { ...EMPTY }
  }
}

export function saveSendSettings(update: Partial<SendSettings>): SendSettings {
  const next = { ...loadSendSettings(), ...update }
  try {
    storage()?.setItem(SEND_KEY, JSON.stringify(next))
  } catch {
    /* private mode: settings last for this page only */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  return next
}

export function onSendSettingsChange(handler: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, handler)
  return () => window.removeEventListener(CHANGE_EVENT, handler)
}

/** Opens the "Send & alerts" panel (from the sidebar, or a send button with nothing configured). */
export function openSendSettings(focus?: 'discord' | 'email'): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(OPEN_EVENT, { detail: focus }))
}

export function onOpenSendSettings(handler: (focus?: 'discord' | 'email') => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<'discord' | 'email' | undefined>).detail)
  window.addEventListener(OPEN_EVENT, listener)
  return () => window.removeEventListener(OPEN_EVENT, listener)
}

/** Same rule as the backend (app/send.py): https, host discord.com or discordapp.com, /api/webhooks/<id>/<token>. */
export function isDiscordWebhook(url: string): boolean {
  return /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d{1,25}\/[A-Za-z0-9_-]{1,200}$/.test(url)
}

export function isEmail(text: string): boolean {
  return /^[^\s@,;?&<>"]+@[^\s@,;?&<>"]+\.[^\s@,;?&<>".]+$/.test(text)
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`
}

const STATUS = { pass: 'Figures checked', retried: 'Figures checked after retry', failed: 'Unverified' } as const
export const DISCORD_DESCRIPTION_MAX = 4096
export const EMAIL_BODY_MAX = 1800
const MAX_FIGURES = 8

export function appLink(): string {
  return `${window.location.origin}/`
}

function figureLines(response: ChatResponse): { name: string; value: string }[] {
  return response.answer.figures.slice(0, MAX_FIGURES).map((f) => ({
    name: truncate(f.hub_id ? `${f.label}, ${hubName(f.hub_id)}` : f.label, 256),
    value: formatValue(f.value, f.unit),
  }))
}

function statusLine(response: ChatResponse, dataAsOf?: string): string {
  const parts: string[] = response.answer.figures.length > 0 || response.grounding.status === 'failed' ? [STATUS[response.grounding.status]] : []
  if (dataAsOf) parts.push(`Data as of ${formatDate(dataAsOf)}`)
  return parts.join('. ')
}

export interface DiscordMessage {
  title: string
  description: string
  fields: { name: string; value: string }[]
  footer: string
  link: string
  verified: boolean | null
}

/** The body of POST /send/discord for one answer (the backend builds the embed and clips it again). */
export function discordMessage(response: ChatResponse, question?: string, dataAsOf?: string): DiscordMessage {
  const hasFigures = response.answer.figures.length > 0
  return {
    title: truncate(question?.trim() || 'Hub Weather Risk answer', 256),
    description: truncate(response.answer.answer, DISCORD_DESCRIPTION_MAX),
    fields: figureLines(response),
    footer: [statusLine(response, dataAsOf), 'Hub Weather Risk'].filter(Boolean).join('. '),
    link: appLink(),
    verified: response.grounding.status === 'failed' ? false : hasFigures ? true : null,
  }
}

/** Markdown to readable plain text for an email body. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A mailto: link with the question as subject and a plain-text body of at most EMAIL_BODY_MAX characters. */
export function mailtoLink(response: ChatResponse, question?: string, dataAsOf?: string, to = ''): string {
  const subject = truncate(`Hub Weather Risk: ${question?.trim() || 'answer'}`, 150)
  const figures = figureLines(response)
  const tail = [
    figures.length ? `Key figures:\n${figures.map((f) => `- ${f.name}: ${f.value}`).join('\n')}` : '',
    statusLine(response, dataAsOf),
    `Hub Weather Risk: ${appLink()}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  const head = question?.trim() ? `Question: ${question.trim()}\n\n` : ''
  const room = Math.max(EMAIL_BODY_MAX - head.length - tail.length - 2, 80)
  const body = truncate(`${head}${truncate(plainText(response.answer.answer), room)}\n\n${tail}`, EMAIL_BODY_MAX)
  const address = isEmail(to.trim()) ? to.trim() : ''
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

export type SendResult = { ok: true; status: string } | { ok: false; status: number; message: string }

async function post(path: string, body: unknown): Promise<SendResult> {
  try {
    const res = await apiFetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const data = (await res.json().catch(() => ({}))) as { status?: string; detail?: string }
    if (res.ok) return { ok: true, status: data.status ?? 'ok' }
    return { ok: false, status: res.status, message: data.detail || `The server answered ${res.status}.` }
  } catch {
    return { ok: false, status: 0, message: 'Could not reach the server. Check your connection and try again.' }
  }
}

export function sendToDiscord(webhookUrl: string, message: DiscordMessage): Promise<SendResult> {
  return post('/send/discord', { webhook_url: webhookUrl, ...message })
}

export function sendTestMessage(webhookUrl: string): Promise<SendResult> {
  return sendToDiscord(webhookUrl, {
    title: 'Test message from Hub Weather Risk',
    description: 'This webhook works. Answers you send from the app will appear in this channel.',
    fields: [],
    footer: 'Hub Weather Risk',
    link: appLink(),
    verified: null,
  })
}

export function subscribeAlerts(webhookUrl: string): Promise<SendResult> {
  return post('/alerts/subscribe', { webhook_url: webhookUrl })
}

export function unsubscribeAlerts(webhookUrl: string): Promise<SendResult> {
  return post('/alerts/unsubscribe', { webhook_url: webhookUrl })
}
