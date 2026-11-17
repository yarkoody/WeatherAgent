import type { UIMessage } from 'ai'

const SESSION_KEY = 'weather-risk.session_id'
const messagesKey = (id: string) => `weather-risk.messages.${id}`

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function newId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** The chat id doubles as the backend session_id, so it survives a page reload. */
export function loadSessionId(): string {
  const s = storage()
  const existing = s?.getItem(SESSION_KEY)
  if (existing) return existing
  const id = newId()
  s?.setItem(SESSION_KEY, id)
  return id
}

export function resetSession(previous: string): string {
  const s = storage()
  s?.removeItem(messagesKey(previous))
  const id = newId()
  s?.setItem(SESSION_KEY, id)
  return id
}

function isMessage(m: unknown): m is UIMessage {
  if (typeof m !== 'object' || m === null) return false
  const { id, role, parts } = m as Record<string, unknown>
  return (
    typeof id === 'string' &&
    (role === 'user' || role === 'assistant' || role === 'system') &&
    Array.isArray(parts) &&
    parts.every((p) => typeof p === 'object' && p !== null && typeof (p as { type?: unknown }).type === 'string')
  )
}

/** Restored history, loosely validated: a bad entry is dropped instead of breaking the app on every load. */
export function loadMessages(id: string): UIMessage[] {
  try {
    const raw = storage()?.getItem(messagesKey(id))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(isMessage) : []
  } catch {
    return []
  }
}

export function saveMessages(id: string, messages: UIMessage[]): void {
  try {
    storage()?.setItem(messagesKey(id), JSON.stringify(messages))
  } catch {
    // Storage full or blocked: the conversation still works, it just won't survive a reload.
  }
}

export function loadFlag(key: string): boolean {
  return storage()?.getItem(`weather-risk.${key}`) === '1'
}

export function saveFlag(key: string, value: boolean): void {
  try {
    storage()?.setItem(`weather-risk.${key}`, value ? '1' : '0')
  } catch {
    /* ignore */
  }
}
