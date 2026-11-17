import type { UIMessage } from 'ai'

import { getChat, saveChatMessages } from './chats'

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** A chat's restored history, loosely validated by the chat store (bad entries are dropped). */
export function loadMessages(id: string): UIMessage[] {
  return getChat(id)?.messages ?? []
}

export function saveMessages(id: string, messages: UIMessage[]): void {
  saveChatMessages(id, messages)
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
