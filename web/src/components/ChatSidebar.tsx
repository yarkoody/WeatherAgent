// Chat history list: "New chat", chats grouped by day, rename in place, delete with a confirmation step.
import { CheckIcon, PencilIcon, PlusIcon, Trash2Icon, XIcon } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button } from '@/components/ui/button'
import { deleteChat, groupChats, loadChats, renameChat, subscribeChats, type StoredChat } from '@/lib/chats'

/** The stored chats, kept in sync with every save (this tab and others). */
export function useChats(): StoredChat[] {
  const [chats, setChats] = useState(loadChats)
  useEffect(() => subscribeChats(() => setChats(loadChats())), [])
  return chats
}

export function ChatSidebar({
  activeId,
  onSelect,
  onNew,
  onDeleted,
}: {
  activeId: string
  onSelect: (id: string) => void
  onNew: () => void
  onDeleted: (id: string) => void
}) {
  const chats = useChats()
  const groups = groupChats(chats)

  return (
    <nav aria-label="Chat history" className="flex h-full min-h-0 flex-col">
      <div className="p-3">
        <Button variant="outline" className="w-full justify-start gap-2 bg-background/60" onClick={onNew}>
          <PlusIcon />
          New chat
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {chats.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">No chats yet.</p>}
        {groups.map((g) => (
          <section key={g.label} aria-labelledby={`chats-${g.label}`} className="mb-3">
            <h3 id={`chats-${g.label}`} className="px-2 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">
              {g.label}
            </h3>
            <ul className="space-y-0.5">
              {g.chats.map((c) => (
                <ChatRow key={c.id} chat={c} active={c.id === activeId} onSelect={onSelect} onDeleted={onDeleted} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="border-t border-border/60 px-4 py-3 text-xs text-muted-foreground">Chats are saved in this browser only.</p>
    </nav>
  )
}

function ChatRow({ chat, active, onSelect, onDeleted }: { chat: StoredChat; active: boolean; onSelect: (id: string) => void; onDeleted: (id: string) => void }) {
  const [mode, setMode] = useState<'view' | 'rename' | 'confirm'>('view')
  const [draft, setDraft] = useState(chat.title)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (mode === 'rename') input.current?.select()
  }, [mode])

  const save = () => {
    renameChat(chat.id, draft)
    setMode('view')
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') save()
    if (e.key === 'Escape') {
      setDraft(chat.title)
      setMode('view')
    }
  }

  if (mode === 'rename')
    return (
      <li className="flex items-center gap-1 rounded-xl bg-background/70 px-2 py-1">
        <input
          ref={input}
          aria-label="Chat title"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          maxLength={80}
          className="min-w-0 flex-1 bg-transparent py-1 text-sm focus-visible:outline-none"
        />
        <Button variant="ghost" size="icon-xs" aria-label="Save title" onClick={save}>
          <CheckIcon />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Cancel rename"
          onClick={() => {
            setDraft(chat.title)
            setMode('view')
          }}
        >
          <XIcon />
        </Button>
      </li>
    )

  if (mode === 'confirm')
    return (
      <li className="rounded-xl bg-band-high-soft/70 px-3 py-2 text-sm" role="group" aria-label={`Delete ${chat.title}?`}>
        <p className="text-band-high-text">Delete this chat? This cannot be undone.</p>
        <div className="mt-1.5 flex gap-2">
          <Button
            size="xs"
            variant="destructive"
            onClick={() => {
              deleteChat(chat.id)
              onDeleted(chat.id)
            }}
          >
            Delete
          </Button>
          <Button size="xs" variant="ghost" onClick={() => setMode('view')} autoFocus>
            Cancel
          </Button>
        </div>
      </li>
    )

  return (
    <li className={`group/row flex items-center rounded-xl ${active ? 'bg-isobar-soft/80 text-foreground' : 'hover:bg-foreground/5'}`}>
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        aria-label={`Open chat: ${chat.title}`}
        onClick={() => onSelect(chat.id)}
        className="min-w-0 flex-1 truncate rounded-xl px-3 py-2 text-left text-sm focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
      >
        {chat.title}
      </button>
      <span className="flex shrink-0 pr-1 opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 max-md:opacity-100">
        <Button variant="ghost" size="icon-xs" aria-label={`Rename ${chat.title}`} onClick={() => setMode('rename')}>
          <PencilIcon />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label={`Delete ${chat.title}`} onClick={() => setMode('confirm')}>
          <Trash2Icon />
        </Button>
      </span>
    </li>
  )
}
