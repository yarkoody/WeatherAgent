// Settings: appearance, developer mode, clear chat history. A glass popover on desktop, a bottom sheet on phones.
import { MonitorIcon, MoonIcon, SettingsIcon, SunIcon, type LucideIcon } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import type { ThemePref } from '@/lib/theme'

interface Props {
  theme: ThemePref
  onTheme: (t: ThemePref) => void
  debug: boolean
  onDebug: (on: boolean) => void
  onClearHistory: () => void
}

const THEMES: { value: ThemePref; label: string; Icon: LucideIcon }[] = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
]

export function Settings({ narrow, ...props }: Props & { narrow: boolean }) {
  const [open, setOpen] = useState(false)
  const row = 'w-full justify-start gap-2 rounded-xl px-2 text-sm font-normal'
  const trigger = (
    <Button variant="ghost" className={row}>
      <SettingsIcon />
      Settings
    </Button>
  )
  if (narrow)
    return (
      <>
        <Button variant="ghost" className={row} aria-expanded={open} onClick={() => setOpen(true)}>
          <SettingsIcon />
          Settings
        </Button>
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="glass rounded-t-3xl px-5 pt-5 pb-8" aria-label="Settings">
            <SheetTitle className="text-base font-semibold">Settings</SheetTitle>
            <SettingsBody {...props} />
          </SheetContent>
        </Sheet>
      </>
    )
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent side="top" align="start" className="glass w-80 gap-0 p-0" aria-label="Settings">
        <p className="px-4 pt-3.5 pb-1 text-sm font-semibold">Settings</p>
        <div className="px-4 pb-3">
          <SettingsBody {...props} />
        </div>
      </PopoverContent>
    </Popover>
  )
}

function Row({ title, description, children, id }: { title: string; description?: string; children: ReactNode; id?: string }) {
  return (
    <section className="border-t border-border/60 py-3 first:border-t-0" aria-labelledby={id}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p id={id} className="text-sm font-medium">
            {title}
          </p>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {children}
      </div>
    </section>
  )
}

function SettingsBody({ theme, onTheme, debug, onDebug, onClearHistory }: Props) {
  const ids = { theme: useId(), dev: useId(), devDesc: useId(), name: useId() }
  const [confirm, setConfirm] = useState(false)

  return (
    <div>
      <section className="py-3" aria-labelledby={ids.theme}>
        <p id={ids.theme} className="text-sm font-medium">
          Appearance
        </p>
        <div role="radiogroup" aria-labelledby={ids.theme} className="mt-2 grid grid-cols-3 gap-1 rounded-xl bg-foreground/5 p-1">
          {THEMES.map(({ value, label, Icon }) => (
            <label
              key={value}
              className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground has-[:checked]:bg-background has-[:checked]:font-medium has-[:checked]:text-foreground has-[:checked]:shadow-sm has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/30"
            >
              <input type="radio" name={ids.name} value={value} checked={theme === value} onChange={() => onTheme(value)} className="sr-only" />
              <Icon className="size-4" aria-hidden="true" />
              {label}
            </label>
          ))}
        </div>
      </section>

      <Row title="Developer mode" description="Show tool names, arguments, trace ids and validation details" id={ids.dev}>
        <Switch checked={debug} onCheckedChange={(v) => onDebug(Boolean(v))} aria-label="Developer mode" />
      </Row>

      <section className="border-t border-border/60 py-3">
        {confirm ? (
          <div role="group" aria-label="Clear chat history?">
            <p className="text-sm text-band-high-text">Delete all chats in this browser? This cannot be undone.</p>
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  onClearHistory()
                  setConfirm(false)
                }}
              >
                Delete all chats
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirm(false)} autoFocus>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Chat history</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Chats are saved in this browser only.</p>
            </div>
            <Button size="sm" variant="ghost" className="text-band-high-text" onClick={() => setConfirm(true)}>
              Clear chat history
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}
