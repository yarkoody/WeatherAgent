// Chat history in this browser's localStorage. Every read and write is guarded: blocked or corrupt storage
// never breaks the app, it just means history is not kept. The chat id is the backend session_id.
import type { UIMessage } from 'ai'

export const CHATS_KEY = 'weather-risk.chats.v1'
const ACTIVE_KEY = 'weather-risk.active_chat'
const EVENT = 'weather-risk:chats'
export const MAX_CHATS = 50
const TITLE_MAX = 40

export interface StoredChat {
  id: string
  title: string
  /** True once the user renamed it: later saves keep the title. */
  renamed?: boolean
  createdAt: number
  updatedAt: number
  messages: UIMessage[]
}

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function newChatId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
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

function toChat(c: unknown): StoredChat | null {
  if (typeof c !== 'object' || c === null) return null
  const { id, title, renamed, createdAt, updatedAt, messages } = c as Record<string, unknown>
  if (typeof id !== 'string' || typeof title !== 'string' || typeof createdAt !== 'number' || typeof updatedAt !== 'number') return null
  return { id, title, renamed: renamed === true, createdAt, updatedAt, messages: Array.isArray(messages) ? messages.filter(isMessage) : [] }
}

/** The version-1 shape kept one conversation under two keys; import it once so nothing is lost. */
function migrateLegacy(s: Storage): StoredChat[] {
  try {
    const id = s.getItem('weather-risk.session_id')
    const raw = id ? s.getItem(`weather-risk.messages.${id}`) : null
    if (!id) return []
    s.removeItem('weather-risk.session_id')
    if (raw) s.removeItem(`weather-risk.messages.${id}`)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    const messages = Array.isArray(parsed) ? parsed.filter(isMessage) : []
    if (messages.length === 0) return []
    const now = Date.now()
    s.setItem(ACTIVE_KEY, id)
    return [{ id, title: titleFrom(messages), createdAt: now, updatedAt: now, messages }]
  } catch {
    return []
  }
}

function read(): StoredChat[] {
  const s = storage()
  if (!s) return []
  try {
    const raw = s.getItem(CHATS_KEY)
    if (!raw) {
      const legacy = migrateLegacy(s)
      if (legacy.length) write(legacy)
      return legacy
    }
    const parsed = JSON.parse(raw) as { version?: unknown; chats?: unknown }
    if (parsed?.version !== 1 || !Array.isArray(parsed.chats)) return []
    return parsed.chats.map(toChat).filter((c): c is StoredChat => c !== null)
  } catch {
    return []
  }
}

function write(chats: StoredChat[]): void {
  const s = storage()
  if (!s) return
  const kept = [...chats].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CHATS)
  try {
    s.setItem(CHATS_KEY, JSON.stringify({ version: 1, chats: kept }))
  } catch {
    // Quota exceeded: drop the oldest half and try once more; otherwise history is simply not saved.
    try {
      s.setItem(CHATS_KEY, JSON.stringify({ version: 1, chats: kept.slice(0, Math.ceil(kept.length / 2)) }))
    } catch {
      /* give up quietly */
    }
  }
  try {
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* no window (tests outside jsdom) */
  }
}

/** All chats, most recently updated first. */
export function loadChats(): StoredChat[] {
  return read().sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getChat(id: string): StoredChat | undefined {
  return read().find((c) => c.id === id)
}

/** "Which Midwest hubs are most exposed to…" from the first question. */
export function titleFrom(messages: UIMessage[]): string {
  const first = messages.find((m) => m.role === 'user')
  const text = first?.parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ').replace(/\s+/g, ' ').trim() ?? ''
  if (!text) return 'New chat'
  if (text.length <= TITLE_MAX) return text
  const cut = text.slice(0, TITLE_MAX)
  return `${cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : TITLE_MAX).trimEnd()}…`
}

/** Add an empty chat ("New chat") to the history right away; its title follows the first question. */
export function createChat(id: string, now = Date.now()): void {
  const chats = read()
  if (chats.some((c) => c.id === id)) return
  write([{ id, title: 'New chat', createdAt: now, updatedAt: now, messages: [] }, ...chats])
}

/** Create or update a chat with its messages (a save with no messages is ignored). */
export function saveChatMessages(id: string, messages: UIMessage[], now = Date.now()): void {
  if (messages.length === 0) return
  const chats = read()
  const existing = chats.find((c) => c.id === id)
  const next: StoredChat = existing
    ? { ...existing, messages, updatedAt: now, title: existing.renamed ? existing.title : titleFrom(messages) }
    : { id, title: titleFrom(messages), createdAt: now, updatedAt: now, messages }
  write([next, ...chats.filter((c) => c.id !== id)])
}

export function renameChat(id: string, title: string): void {
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 80)
  if (!clean) return
  write(read().map((c) => (c.id === id ? { ...c, title: clean, renamed: true } : c)))
}

export function clearChats(): void {
  write([])
}

export function deleteChat(id: string): void {
  write(read().filter((c) => c.id !== id))
}

export function loadActiveChatId(): string | null {
  try {
    return storage()?.getItem(ACTIVE_KEY) ?? null
  } catch {
    return null
  }
}

export function saveActiveChatId(id: string): void {
  try {
    storage()?.setItem(ACTIVE_KEY, id)
  } catch {
    /* ignore */
  }
}

/** Re-render on any change to the stored chats. */
export function subscribeChats(listener: () => void): () => void {
  window.addEventListener(EVENT, listener)
  window.addEventListener('storage', listener) // another tab
  return () => {
    window.removeEventListener(EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

export function groupChats(chats: StoredChat[], now = Date.now()): { label: 'Today' | 'Yesterday' | 'Earlier'; chats: StoredChat[] }[] {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const today = start.getTime()
  const yesterday = today - 86_400_000
  const groups = { Today: [] as StoredChat[], Yesterday: [] as StoredChat[], Earlier: [] as StoredChat[] }
  for (const c of chats) groups[c.updatedAt >= today ? 'Today' : c.updatedAt >= yesterday ? 'Yesterday' : 'Earlier'].push(c)
  return (['Today', 'Yesterday', 'Earlier'] as const).filter((l) => groups[l].length).map((label) => ({ label, chats: groups[label] }))
}

/** What each request carries: the whole conversation, but only user text and the verified answer text. */
export function compactHistory(messages: UIMessage[]): UIMessage[] {
  const out: UIMessage[] = []
  for (const m of messages) {
    if (m.role === 'user') {
      const parts = m.parts.filter((p) => p.type === 'text')
      if (parts.length) out.push({ id: m.id, role: 'user', parts })
    } else if (m.role === 'assistant') {
      const answer = m.parts.find((p) => p.type === 'data-answer') as { data?: { answer?: { answer?: unknown } } } | undefined
      const text = answer?.data?.answer?.answer
      if (typeof text === 'string')
        out.push({ id: m.id, role: 'assistant', parts: [{ type: 'data-answer', data: { answer: { answer: text } } }] as UIMessage['parts'] })
    }
  }
  return out
}
