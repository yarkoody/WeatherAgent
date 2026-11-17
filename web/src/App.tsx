import { PlusIcon, Volume2Icon, VolumeOffIcon } from 'lucide-react'
import { Suspense, lazy, useState } from 'react'
import { DebugProvider, readDebugFlag } from '@/lib/debug'
import { ChatView } from '@/components/ChatView'
import { Button } from '@/components/ui/button'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { USE_MOCKS } from '@/lib/mockFetch'
import { loadFlag, loadSessionId, resetSession, saveFlag } from '@/lib/session'
import { speechSupported, stopSpeaking } from '@/lib/voice'

const ScoresView = lazy(() => import('@/components/ScoresView').then((m) => ({ default: m.ScoresView })))

type View = 'chat' | 'scores'

export default function App() {
  const [view, setView] = useState<View>('chat')
  const [sessionId, setSessionId] = useState(loadSessionId)
  const [speakOn, setSpeakOn] = useState(() => loadFlag('speak'))
  const [debug] = useState(() => readDebugFlag())
  const canSpeak = speechSupported()

  function newConversation() {
    stopSpeaking()
    setSessionId(resetSession(sessionId))
    setView('chat')
  }

  function onSpeakChange(next: boolean) {
    if (!next) stopSpeaking()
    setSpeakOn(next)
    saveFlag('speak', next)
  }

  return (
    <DebugProvider debug={debug}>
    <TooltipProvider>
      <div className="flex h-dvh flex-col">
        <header className="border-b bg-background">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-2.5 sm:gap-3 sm:px-6">
            <a href="/" className="flex shrink-0 items-center gap-2" aria-label="Hub Weather Risk" onClick={(e) => (e.preventDefault(), setView('chat'))}>
              <img src="/favicon.svg" alt="" width={26} height={26} />
              <span className="font-wide hidden text-[0.95rem] font-bold tracking-tight whitespace-nowrap md:inline">Hub Weather Risk</span>
            </a>
            {USE_MOCKS && (
              <span className="hidden rounded bg-band-medium-soft px-1.5 py-0.5 text-[0.65rem] font-semibold whitespace-nowrap text-[#7a5612] sm:inline">
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
            <nav className="flex gap-1 sm:ml-2" aria-label="Views">
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
            <span className="flex-1" />
            {canSpeak && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Toggle
                      pressed={speakOn}
                      onPressedChange={onSpeakChange}
                      aria-label={speakOn ? 'Stop reading answers aloud' : 'Read answers aloud'}
                    />
                  }
                >
                  {speakOn ? <Volume2Icon /> : <VolumeOffIcon />}
                </TooltipTrigger>
                <TooltipContent>{speakOn ? 'Answers are read aloud' : 'Read answers aloud'}</TooltipContent>
              </Tooltip>
            )}
            <Button variant="outline" size="sm" onClick={newConversation}>
              <PlusIcon />
              <span className="hidden sm:inline">New conversation</span>
              <span className="sm:hidden">New</span>
            </Button>
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col">
          {/* The chat stays mounted while Scores is open, so a running answer is not lost. */}
          <div className={view === 'chat' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}>
            <ChatView key={sessionId} sessionId={sessionId} speakAnswers={speakOn} onReset={newConversation} />
          </div>
          {view === 'scores' && (
            <Suspense fallback={null}>
              <ScoresView />
            </Suspense>
          )}
        </main>
      </div>
    </TooltipProvider>
    </DebugProvider>
  )
}
