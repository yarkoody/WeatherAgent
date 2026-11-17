import { createContext, useContext, type ReactNode } from 'react'
import type { HubHistory } from './types'

interface AskContextValue {
  /** Send a question in the current chat (from a widget, e.g. "Show observed history"). */
  ask?: (text: string) => void
  /** Histories the agent already fetched in this chat, by hub id. */
  histories: Record<string, HubHistory>
}

const AskContext = createContext<AskContextValue>({ histories: {} })

export function AskProvider({ ask, histories, children }: AskContextValue & { children: ReactNode }) {
  return <AskContext.Provider value={{ ask, histories }}>{children}</AskContext.Provider>
}

export function useAsk(): AskContextValue {
  return useContext(AskContext)
}
