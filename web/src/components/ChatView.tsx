// AI Elements "Chat" pattern: Message turns inside a Message Scroller, with Prompt Input below.
import { useChat } from '@ai-sdk/react'
import { DefaultChatTransport, type UIMessage } from 'ai'
import { CloudLightningIcon } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { Suggestions } from '@/components/ai-elements/suggestions'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Message, MessageContent } from '@/components/ui/message'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from '@/components/ui/message-scroller'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { chatFetch, describeChatError } from '@/lib/chatErrors'
import { compactHistory } from '@/lib/chats'
import { NoMotion, useReducedMotion } from '@/lib/motion'
import { loadMessages, saveMessages } from '@/lib/session'
import { answerSpeech, speak } from '@/lib/voice'
import { AssistantMessage, NoAnswer, answerPart } from './AssistantMessage'
import { COMPOSER_INPUT_ID, Composer } from './Composer'

export const SUGGESTIONS = [
  'Which Midwest hubs are most exposed to winter weather?',
  'Compare Houston and Dallas on flood risk.',
  'What percentage of days did it snow in Denver in 2025?',
  'Are there any active weather alerts for Houston?',
]

function userText(m: UIMessage): string {
  return m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
}

const PENDING: UIMessage = { id: 'pending', role: 'assistant', parts: [] }

/**
 * Each request carries the chat id and the whole conversation, compacted to user text and the verified answer
 * text. The server uses it only when its own history for this id is missing (for example after a redeploy).
 */
export function withCompactHistory({ id, messages }: { id: string; messages: UIMessage[] }) {
  return { body: { id, messages: compactHistory(messages) } }
}

export function ChatView({ sessionId, speakAnswers, onReset }: { sessionId: string; speakAnswers: boolean; onReset?: () => void }) {
  return (
    <ErrorBoundary
      fallback={() => (
        <Empty className="h-full px-4">
          <EmptyHeader>
            <EmptyTitle>This conversation could not be shown.</EmptyTitle>
            <EmptyDescription>Start a new conversation to continue. The saved history for this one will be cleared.</EmptyDescription>
          </EmptyHeader>
          {onReset && (
            <EmptyContent>
              <Button onClick={onReset}>Start a new conversation</Button>
            </EmptyContent>
          )}
        </Empty>
      )}
    >
      <ChatThread sessionId={sessionId} speakAnswers={speakAnswers} />
    </ErrorBoundary>
  )
}

function ChatThread({ sessionId, speakAnswers }: { sessionId: string; speakAnswers: boolean }) {
  const transport = useMemo(
    () => new DefaultChatTransport({ api: '/chat', fetch: chatFetch, prepareSendMessagesRequest: withCompactHistory }),
    [],
  )
  const initial = useMemo(() => loadMessages(sessionId), [sessionId])
  const { messages, sendMessage, status, error, stop, regenerate } = useChat({ id: sessionId, messages: initial, transport })
  const busy = status === 'submitted' || status === 'streaming'
  // Messages restored from history render without animation; only new results animate in.
  const restored = useMemo(() => new Set(initial.map((m) => m.id)), [initial])

  useEffect(() => {
    if (status === 'ready' || status === 'error') saveMessages(sessionId, messages)
  }, [status, messages, sessionId])

  // "New conversation" unmounts this thread: abort a request still in flight.
  const stopRef = useRef(stop)
  stopRef.current = stop
  useEffect(() => () => void stopRef.current(), [])

  // Read each new answer aloud once (never the restored history).
  const spoken = useRef<string | null>(initial.at(-1)?.id ?? null)
  useEffect(() => {
    const last = messages.at(-1)
    if (status !== 'ready' || !last || last.role !== 'assistant' || spoken.current === last.id) return
    spoken.current = last.id
    const r = answerPart(last)
    if (speakAnswers && r) speak(answerSpeech(r))
  }, [messages, status, speakAnswers])

  // One send path for the composer, the starter questions and the "Ask next" chips.
  const send = (text: string) => {
    void sendMessage({ text })
    // Keep focus in the composer: a clicked chip unmounts, and focus must not fall back to the page.
    document.getElementById(COMPOSER_INPUT_ID)?.focus({ preventScroll: true })
  }
  // While the request is in flight there is no assistant message yet: show its steps placeholder.
  const thread = status === 'submitted' && messages.at(-1)?.role === 'user' ? [...messages, PENDING] : messages
  const lastId = thread.at(-1)?.id

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        {thread.length === 0 ? (
          <Empty className="h-full px-4">
            <EmptyHeader className="max-w-xl">
              <EmptyMedia variant="icon">
                <CloudLightningIcon />
              </EmptyMedia>
              <EmptyTitle className="heading-tight text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
                Where will weather hit your network hardest?
              </EmptyTitle>
              <EmptyDescription>
                Ask about disruption exposure and investment priority for 15 US logistics hubs. Every figure in an answer is validated against the scoring data, and charts are
                drawn from it directly.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="max-w-2xl">
              <Suggestions suggestions={SUGGESTIONS} onPick={send} />
            </EmptyContent>
          </Empty>
        ) : (
          <MessageScrollerProvider autoScroll defaultScrollPosition="end">
            <FollowLatest count={thread.length} lastIsUser={thread.at(-1)?.role === 'user'} />
            <MessageScroller>
              {/* Gutter on both edges keeps the centered column symmetric when a scrollbar shows. */}
              <MessageScrollerViewport className="[scrollbar-gutter:stable_both-edges]">
                <MessageScrollerContent aria-busy={busy} className="mx-auto w-full max-w-3xl gap-7 px-4 py-6 sm:px-6">
                  {thread.map((m) =>
                    m.role === 'user' ? (
                      <MessageScrollerItem key={m.id} messageId={m.id}>
                        <Message align="end">
                          <MessageContent>
                            <Bubble align="end">
                              <BubbleContent className="text-base whitespace-pre-wrap">{userText(m)}</BubbleContent>
                            </Bubble>
                          </MessageContent>
                        </Message>
                      </MessageScrollerItem>
                    ) : (
                      <MessageScrollerItem key={m.id} messageId={m.id}>
                        {restored.has(m.id) ? (
                          <NoMotion>
                            <AssistantMessage message={m} streaming={false} latest={!busy && m.id === lastId} onFollowUp={send} />
                          </NoMotion>
                        ) : (
                          <AssistantMessage message={m} streaming={busy && m.id === lastId} latest={!busy && m.id === lastId} onFollowUp={send} />
                        )}
                      </MessageScrollerItem>
                    ),
                  )}
                  {/* Stopped (or reloaded) before the first chunk: the question has no reply at all. */}
                  {!busy && !error && thread.at(-1)?.role === 'user' && (
                    <MessageScrollerItem messageId="no-answer">
                      <Message>
                        <MessageContent>
                          <NoAnswer />
                        </MessageContent>
                      </Message>
                    </MessageScrollerItem>
                  )}
                  {error && <ChatError error={error} onRetry={() => regenerate()} />}
                </MessageScrollerContent>
              </MessageScrollerViewport>
              <MessageScrollerButton />
            </MessageScroller>
          </MessageScrollerProvider>
        )}
      </div>
      <div className="relative z-10">
        <div className="mx-auto w-full max-w-3xl px-4 py-3 sm:px-6">
          <Composer busy={busy} onSend={send} onStop={stop} />
          <p className="mt-1.5 text-center text-[0.7rem] text-muted-foreground">
            Scores come from a fixed data snapshot. Every figure is validated against the scoring data.
          </p>
        </div>
      </div>
    </div>
  )
}

function ChatError({ error, onRetry }: { error: Error; onRetry: () => void }) {
  const view = describeChatError(error)
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-3xl bg-band-high-soft px-5 py-3.5 text-sm text-band-high-text" role="alert">
      <div className="min-w-0 flex-1">
        <p>{view.title}</p>
        {view.detail && <p className="mt-0.5 text-xs opacity-80">{view.detail}</p>}
      </div>
      {view.canRetry && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  )
}

/**
 * When a question is sent (from the composer or a chip), scroll the thread to the newest message, so the question
 * shows at the bottom and the reply streams in under it. Smooth unless the user asked for reduced motion.
 */
function FollowLatest({ count, lastIsUser }: { count: number; lastIsUser: boolean }) {
  const { scrollToEnd } = useMessageScroller()
  const reduced = useReducedMotion()
  const seen = useRef(count)
  useEffect(() => {
    if (count > seen.current && lastIsUser) scrollToEnd({ behavior: reduced ? 'auto' : 'smooth' })
    seen.current = count
  }, [count, lastIsUser, reduced, scrollToEnd])
  return null
}
