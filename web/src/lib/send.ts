// "Send & alerts": score-change alerts to the user's Discord webhook, set up from the sidebar.
// The browser remembers what it set up (localStorage); the server keeps the subscriptions and sends the alerts.
import { apiFetch } from './mockFetch'

export const SEND_KEY = 'weather-risk.send.v2'
const OPEN_EVENT = 'send-settings:open'

export interface SendSettings {
  discordWebhook: string
  /** This browser subscribed the webhook to score-change alerts. */
  discordAlerts: boolean
}

const EMPTY: SendSettings = { discordWebhook: '', discordAlerts: false }

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
    const discordWebhook = typeof raw.discordWebhook === 'string' && isDiscordWebhook(raw.discordWebhook) ? raw.discordWebhook : ''
    return { discordWebhook, discordAlerts: raw.discordAlerts === true && discordWebhook !== '' }
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
  return next
}

/** Opens the "Send & alerts" panel. */
export function openSendSettings(): void {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

export function onOpenSendSettings(handler: () => void): () => void {
  window.addEventListener(OPEN_EVENT, handler)
  return () => window.removeEventListener(OPEN_EVENT, handler)
}

/** Same rule as the backend (app/send.py): https, host discord.com or discordapp.com, /api/webhooks/<id>/<token>. */
export function isDiscordWebhook(url: string): boolean {
  return /^https:\/\/(discord|discordapp)\.com\/api\/webhooks\/\d{1,25}\/[A-Za-z0-9_-]{1,200}$/.test(url)
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

export function sendTestMessage(webhookUrl: string): Promise<SendResult> {
  return post('/send/discord', { webhook_url: webhookUrl })
}

export function subscribeAlerts(webhookUrl: string): Promise<SendResult> {
  return post('/alerts/subscribe', { webhook_url: webhookUrl })
}

export function unsubscribeAlerts(webhookUrl: string): Promise<SendResult> {
  return post('/alerts/unsubscribe', { webhook_url: webhookUrl })
}
