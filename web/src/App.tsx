import { BookOpenIcon, MenuIcon, PlusIcon } from 'lucide-react'
import { Suspense, useEffect, useRef, useState } from 'react'
import { lazyWithReload } from '@/lib/chunkReload'
import { Settings } from '@/components/SettingsPanel'
import { MethodologyHost } from '@/components/MethodologyHost'
import { openMethodology } from '@/lib/methodology'
import { DebugProvider, readDebugFlag, saveDebugFlag } from '@/lib/debug'
import { useThemePref } from '@/lib/theme'
import { ChatSidebar } from '@/components/ChatSidebar'
import { ChatView } from '@/components/ChatView'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { clearChats, createChat, getChat, loadActiveChatId, loadChats, newChatId, saveActiveChatId } from '@/lib/chats'
import { useMediaQuery } from '@/lib/useMediaQuery'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { USE_MOCKS } from '@/lib/mockFetch'
import { loadFlag, saveFlag } from '@/lib/session'
import { stopSpeaking } from '@/lib/voice'

const ScoresView = lazyWithReload(() => import('@/components/ScoresView').then((m) => ({ default: m.ScoresView })))

type View = 'chat' | 'scores'

export default function App() {
  const [view, setView] = useState<View>('chat')
  // The active chat id is the useChat id and the backend session_id.
  const [chatId, setChatId] = useState(() => loadActiveChatId() ?? newChatId())
  // Remember the open chat (also a brand-new one), so a reload reopens it.
  useEffect(() => saveActiveChatId(chatId), [chatId])
  const narrow = useMediaQuery('(max-width: 767px)')
  const [sidebarOpen, setSidebarOpen] = useState(() => !loadFlag('sidebar-hidden'))
  const [sheetOpen, setSheetOpen] = useState(false)
  const menuButton = useRef<HTMLButtonElement>(null)
  const historyOpen = narrow ? sheetOpen : sidebarOpen
  const [debug, setDebugState] = useState(() => readDebugFlag())
  const [theme, setTheme] = useThemePref()
  const setDebug = (on: boolean) => {
    saveDebugFlag(on)
    setDebugState(on)
  }

  function openChat(id: string) {
    stopSpeaking()
    setChatId(id)
    saveActiveChatId(id)
    setView('chat')
    setSheetOpen(false)
  }

  /**
   * "New chat" adds a chat to the history at once and opens it; the current chat stays in the history.
   * If the open chat has no messages yet, that one is the new chat (listed now if it was not yet).
   */
  function newChat() {
    if ((getChat(chatId)?.messages.length ?? 0) === 0) {
      createChat(chatId)
      setView('chat')
      setSheetOpen(false)
      return
    }
    const id = newChatId()
    createChat(id)
    openChat(id)
  }

  function onDeleted(id: string) {
    if (id !== chatId) return
    const next = loadChats()[0]
    openChat(next ? next.id : newChatId())
  }

  function toggleSidebar() {
    if (narrow) return setSheetOpen((open) => !open)
    setSidebarOpen((open) => {
      saveFlag('sidebar-hidden', open)
      return !open
    })
  }

  const settings = (
      <Settings
              narrow={narrow}
              theme={theme}
              onTheme={setTheme}
              debug={debug}
              onDebug={setDebug}
              onClearHistory={() => {
                clearChats()
                openChat(newChatId())
              }}
            />
  )
  const sidebar = (
    <ChatSidebar
      activeId={chatId}
      onSelect={openChat}
      onNew={newChat}
      onDeleted={onDeleted}
      footer={
        <>
          <Button variant="ghost" className="w-full justify-start gap-2 px-2 text-sm font-normal" onClick={() => openMethodology()}>
            <BookOpenIcon />
            Methodology
          </Button>
          {settings}
        </>
      }
    />
  )



  return (
    <DebugProvider debug={debug}>
      <MethodologyHost />
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <header className="glass-bar relative z-20">
          {/* Three columns: the tabs sit in the middle of the page width, not the leftover space.
              The side columns never shrink below their content, so the tabs shift rather than overlap. */}
          <div className="grid w-full grid-cols-[minmax(max-content,1fr)_auto_minmax(max-content,1fr)] items-center gap-2 px-2 py-2 sm:gap-3 sm:px-3">
            <div className="flex items-center gap-2 sm:gap-3">
              {/* Hamburger: opens and closes the chat history on every screen size. */}
              <Button
                ref={menuButton}
                variant="ghost"
                size="icon-sm"
                onClick={toggleSidebar}
                aria-label={historyOpen ? 'Close chat history' : 'Open chat history'}
                aria-expanded={historyOpen}
                aria-controls="chat-history"
              >
                <MenuIcon />
              </Button>
              <a href="/" className="flex shrink-0 items-center gap-2" aria-label="Hub Weather Risk" onClick={(e) => (e.preventDefault(), setView('chat'))}>
                <img src="/favicon.svg" alt="" width={26} height={26} />
                <span className="heading-tight hidden text-[0.95rem] font-semibold tracking-tight whitespace-nowrap md:inline">Hub Weather Risk</span>
              </a>
              {USE_MOCKS && (
                <span className="hidden rounded bg-band-medium-soft px-1.5 py-0.5 text-[0.65rem] font-semibold whitespace-nowrap text-band-medium-text sm:inline">
                  Mock data
                </span>
              )}
              {debug && (
                <a
                  href="?debug=0"
                  title="Shows tool names, arguments, trace ids and grounding errors. Click to turn off."
                  className="rounded bg-isobar-soft px-1.5 py-0.5 text-[0.65rem] font-semibold whitespace-nowrap text-isobar"
                >
                  Developer view
                </a>
              )}
            </div>
            <nav className="flex gap-1" aria-label="Views">
              {(['chat', 'scores'] as const).map((v) => (
                <Button
                  key={v}
                  variant={view === v ? 'secondary' : 'ghost'}
                  size="sm"
                  onClick={() => setView(v)}
                  aria-current={view === v ? 'page' : undefined}
                >
                  {v === 'chat' ? 'Ask' : 'Scores'}
                </Button>
              ))}
            </nav>
            <div className="flex items-center justify-end gap-2">
              {narrow && (
                <Button variant="outline" size="icon-sm" onClick={newChat} aria-label="Start a new chat">
                  <PlusIcon />
                </Button>
              )}
            </div>
          </div>
        </header>
        <div className="flex min-h-0 flex-1">
        {!narrow && sidebarOpen && (
          <aside id="chat-history" className="glass-bar relative z-10 hidden w-64 shrink-0 md:flex md:flex-col">
            {sidebar}
          </aside>
        )}
        {narrow && (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent id="chat-history" side="left" className="glass w-72 gap-0 p-0 pt-10" finalFocus={menuButton}>
              <SheetTitle className="sr-only">Chat history</SheetTitle>
              {sidebar}
            </SheetContent>
          </Sheet>
        )}
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* The chat stays mounted while Scores is open, so a running answer is not lost. */}
          <div className={view === 'chat' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <ChatView key={chatId} sessionId={chatId} onReset={() => openChat(newChatId())} />
          </div>
          {view === 'scores' && (
            <Suspense fallback={null}>
              <ScoresView />
            </Suspense>
          )}
        </main>
        </div>
      </div>
    </TooltipProvider>
    </DebugProvider>
  )
}
