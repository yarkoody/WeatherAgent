// Appearance: light, dark or system. The resolved theme is set on <html data-theme> (index.html does it once
// before first paint, so there is no flash); the CSS dark tokens hang off [data-theme='dark'].
import { useCallback, useEffect, useState } from 'react'

export type ThemePref = 'light' | 'dark' | 'system'
export const THEME_KEY = 'weather-risk.theme'
const QUERY = '(prefers-color-scheme: dark)'

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY)
    return v === 'light' || v === 'dark' ? v : 'system'
  } catch {
    return 'system'
  }
}

function saveThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* not persisted */
  }
}

export function systemIsDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  return pref === 'system' ? (systemIsDark() ? 'dark' : 'light') : pref
}

export function applyTheme(pref: ThemePref): void {
  const theme = resolveTheme(pref)
  const root = document.documentElement
  root.dataset.theme = theme
  root.style.colorScheme = theme
}

/** The stored preference, applied to the page; with "system", it follows the OS setting live. */
export function useThemePref(): [ThemePref, (pref: ThemePref) => void] {
  const [pref, setPrefState] = useState<ThemePref>(loadThemePref)
  useEffect(() => {
    applyTheme(pref)
    if (pref !== 'system' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(QUERY)
    const onChange = () => applyTheme('system')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [pref])
  const setPref = useCallback((next: ThemePref) => {
    saveThemePref(next)
    setPrefState(next)
  }, [])
  return [pref, setPref]
}
