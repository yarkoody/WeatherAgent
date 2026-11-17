import { createContext, useContext, type ReactNode } from 'react'

const KEY = 'weather-risk.debug'

/**
 * Developer view: `?debug=1` turns it on and remembers it, `?debug=0` turns it off.
 * Without the parameter the remembered choice applies; the default is off (analyst view).
 */
export function readDebugFlag(search: string = typeof window === 'undefined' ? '' : window.location.search): boolean {
  const param = new URLSearchParams(search).get('debug')
  try {
    if (param === '1') localStorage.setItem(KEY, '1')
    if (param === '0') localStorage.removeItem(KEY)
    return localStorage.getItem(KEY) === '1'
  } catch {
    return param === '1'
  }
}

const DebugContext = createContext(false)

export function DebugProvider({ debug, children }: { debug: boolean; children: ReactNode }) {
  return <DebugContext.Provider value={debug}>{children}</DebugContext.Provider>
}

/** True in developer view: show tool names, arguments, trace ids and grounding errors. */
export function useDebug(): boolean {
  return useContext(DebugContext)
}
