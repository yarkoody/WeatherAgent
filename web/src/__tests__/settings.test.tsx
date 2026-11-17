// Settings: appearance (light / dark / system), developer mode, clear chat history.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { UIMessage } from 'ai'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { loadChats, saveChatMessages } from '../lib/chats'
import { readDebugFlag } from '../lib/debug'
import { THEME_KEY } from '../lib/theme'
import { sseEvents } from './fixtures'

/** A finished assistant turn rebuilt from a recorded stream: tool part + data-answer. */
function recordedTurn(): UIMessage[] {
  const events = sseEvents('chat-stream-weather.sse')
  const input = events.find((e) => e.type === 'tool-input-available')!
  const output = events.find((e) => e.type === 'tool-output-available')!
  const answer = events.find((e) => e.type === 'data-answer')!
  return [
    { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'Denver snow days 2025' }] },
    {
      id: 'a1',
      role: 'assistant',
      parts: [
        { type: `tool-${input.toolName}`, toolCallId: input.toolCallId, state: 'output-available', input: input.input, output: output.output },
        { type: 'data-answer', data: answer.data },
      ] as UIMessage['parts'],
    },
  ]
}

/** matchMedia stub: `dark` decides prefers-color-scheme; listeners can be fired by hand. */
function media(dark: boolean) {
  const listeners = new Set<() => void>()
  const state = { dark }
  vi.stubGlobal('matchMedia', (q: string) => ({
    get matches() {
      return q === '(prefers-color-scheme: dark)' ? state.dark : false
    },
    addEventListener: (_: string, l: () => void) => listeners.add(l),
    removeEventListener: (_: string, l: () => void) => listeners.delete(l),
  }))
  return {
    set(next: boolean) {
      state.dark = next
      act(() => listeners.forEach((l) => l()))
    },
  }
}

const openSettings = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
  return screen.findByRole('dialog', { name: 'Settings' })
}

beforeEach(() => {
  localStorage.clear()
  delete document.documentElement.dataset.theme
})
afterEach(() => {
  vi.unstubAllGlobals()
  window.history.replaceState({}, '', '/')
})

describe('appearance', () => {
  it('switches between light and dark, and the choice persists', async () => {
    media(false)
    const { unmount } = render(<App />)
    const panel = await openSettings()
    fireEvent.click(within(panel).getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(localStorage.getItem(THEME_KEY)).toBe('dark')
    fireEvent.click(within(panel).getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.dataset.theme).toBe('light')
    unmount()

    delete document.documentElement.dataset.theme
    render(<App />) // "reload"
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(within(await openSettings()).getByRole('radio', { name: 'Light' })).toBeChecked()
  })

  it('System is the default and follows the operating system setting', async () => {
    const os = media(true)
    render(<App />)
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(within(await openSettings()).getByRole('radio', { name: 'System' })).toBeChecked()
    os.set(false)
    expect(document.documentElement.dataset.theme).toBe('light')
  })
})

describe('developer mode', () => {
  it('shows and hides tool details and the Developer view pill, and is remembered', async () => {
    media(false)
    saveChatMessages('c1', recordedTurn())
    localStorage.setItem('weather-risk.active_chat', 'c1')
    render(<App />)
    expect(screen.queryByText('Developer view')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Analysis steps/ })).toBeInTheDocument() // analyst view folds the steps

    const panel = await openSettings()
    const toggle = within(panel).getByRole('switch', { name: 'Developer mode' })
    expect(within(panel).getByText('Show tool names, arguments, trace ids and validation details')).toBeInTheDocument()
    fireEvent.click(toggle)
    expect(screen.getByText('Developer view')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Analysis steps/ })).not.toBeInTheDocument() // steps open, with tool names
    expect(screen.getByText(/^trace /)).toBeInTheDocument()
    expect(readDebugFlag('')).toBe(true)

    fireEvent.click(toggle)
    expect(screen.queryByText('Developer view')).not.toBeInTheDocument()
    expect(readDebugFlag('')).toBe(false)
  })

  it('?debug=1 turns it on and the switch shows it', async () => {
    media(false)
    window.history.replaceState({}, '', '/?debug=1')
    render(<App />)
    expect(screen.getByText('Developer view')).toBeInTheDocument()
    expect(within(await openSettings()).getByRole('switch', { name: 'Developer mode' })).toBeChecked()
  })
})

describe('clear chat history', () => {
  it('asks first, then deletes every chat', async () => {
    media(false)
    saveChatMessages('a', recordedTurn())
    saveChatMessages('b', [{ id: 'u9', role: 'user', parts: [{ type: 'text', text: 'Rank hubs' }] }])
    render(<App />)
    const panel = await openSettings()
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear chat history' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
    expect(loadChats()).toHaveLength(2)
    fireEvent.click(within(panel).getByRole('button', { name: 'Clear chat history' }))
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete all chats' }))
    await waitFor(() => expect(loadChats()).toHaveLength(0))
    expect(within(screen.getByRole('navigation', { name: 'Chat history' })).getByText('No chats yet.')).toBeInTheDocument()
  })
})
