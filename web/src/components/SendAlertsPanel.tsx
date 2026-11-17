// "Send & alerts": score-change alerts to the user's Discord webhook, in one side sheet opened from the sidebar.
import { LoaderCircleIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  isDiscordWebhook,
  loadSendSettings,
  onOpenSendSettings,
  saveSendSettings,
  sendTestMessage,
  subscribeAlerts,
  unsubscribeAlerts,
} from '@/lib/send'

type Note = { tone: 'ok' | 'error' | 'info'; text: string } | null

export function SendAlertsHost() {
  const [open, setOpen] = useState(false)
  useEffect(() => onOpenSendSettings(() => setOpen(true)), [])
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="glass gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md" aria-describedby={undefined}>
        <SheetHeader className="border-b border-border/60 px-5 py-4">
          <SheetTitle className="heading-tight text-lg">Send &amp; alerts</SheetTitle>
          <SheetDescription>Get a Discord message when a hub's risk score changes.</SheetDescription>
        </SheetHeader>
        {open && <SendAlertsPanel />}
      </SheetContent>
    </Sheet>
  )
}

function NoteLine({ note }: { note: Note }) {
  if (!note) return null
  const tone = note.tone === 'error' ? 'text-band-high-text' : note.tone === 'ok' ? 'text-band-low-text' : 'text-muted-foreground'
  return (
    <p role="status" className={`mt-2 text-xs ${tone}`}>
      {note.text}
    </p>
  )
}

export function SendAlertsPanel() {
  const ids = { hook: useId(), hookHelp: useId(), alerts: useId() }
  const initial = useRef(loadSendSettings()).current
  const [hook, setHook] = useState(initial.discordWebhook)
  const [saved, setSaved] = useState(initial)
  const [note, setNote] = useState<Note>(null)
  const [busy, setBusy] = useState<'test' | 'alerts' | null>(null)
  const hookInvalid = hook.trim() !== '' && !isDiscordWebhook(hook.trim())

  /** A subscription belongs to one webhook: a new (or cleared) webhook ends the old subscription. */
  function changeHook(value: string) {
    setHook(value)
    const next = value.trim()
    if (next !== '' && !isDiscordWebhook(next)) return
    const current = loadSendSettings()
    if (next === current.discordWebhook) return
    if (current.discordAlerts) {
      void unsubscribeAlerts(current.discordWebhook)
      setNote({ tone: 'info', text: 'Alerts were turned off because the webhook changed. Turn them on again for the new one.' })
    } else {
      setNote(next ? { tone: 'ok', text: 'Saved in this browser.' } : null)
    }
    setSaved(saveSendSettings({ discordWebhook: next, discordAlerts: false }))
  }

  async function test() {
    setBusy('test')
    const res = await sendTestMessage(saved.discordWebhook)
    setBusy(null)
    setNote(res.ok ? { tone: 'ok', text: 'Test message sent. Check the Discord channel.' } : { tone: 'error', text: res.message })
  }

  async function toggle(on: boolean) {
    setBusy('alerts')
    const res = on ? await subscribeAlerts(saved.discordWebhook) : await unsubscribeAlerts(saved.discordWebhook)
    setBusy(null)
    if (!res.ok) return setNote({ tone: 'error', text: res.message })
    setSaved(saveSendSettings({ discordAlerts: on }))
    setNote(on ? { tone: 'ok', text: 'Subscribed. A confirmation was posted to the channel.' } : { tone: 'info', text: 'Unsubscribed. No more alerts in this channel.' })
  }

  return (
    <div className="px-5 py-2 text-sm">
      <p className="pt-3 text-xs text-muted-foreground">
        You get a message when a hub's exposure or review priority moves 5 points or more, or its level changes, and for severe
        live NWS alerts at a hub.
      </p>

      <section className="py-4" aria-labelledby={`${ids.hook}-title`}>
        <h3 id={`${ids.hook}-title`} className="font-medium">
          Discord
        </h3>
        <label htmlFor={ids.hook} className="mt-2 block text-xs text-muted-foreground">
          Webhook URL
        </label>
        <Input
          id={ids.hook}
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://discord.com/api/webhooks/…"
          value={hook}
          onChange={(e) => changeHook(e.target.value)}
          aria-invalid={hookInvalid || undefined}
          aria-describedby={ids.hookHelp}
          className="mt-1"
        />
        {hookInvalid && (
          <p className="mt-1 text-xs text-band-high-text">Paste a Discord webhook URL: it starts with https://discord.com/api/webhooks/.</p>
        )}
        <p id={ids.hookHelp} className="mt-2 text-xs text-muted-foreground">
          In Discord: channel settings, Integrations, Webhooks, New Webhook, Copy Webhook URL. Anyone with the URL can post to that
          channel, so treat it like a password.
        </p>
        <div className="mt-3">
          <Button size="sm" variant="outline" disabled={!saved.discordWebhook || busy !== null} onClick={() => void test()}>
            {busy === 'test' ? <LoaderCircleIcon className="animate-spin" /> : null}
            Send test message
          </Button>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span id={ids.alerts}>Alert this channel when a hub's score changes</span>
          {busy === 'alerts' ? (
            <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" aria-label="Updating" />
          ) : (
            <Switch
              checked={saved.discordAlerts}
              disabled={!saved.discordWebhook || busy !== null}
              onCheckedChange={(v) => void toggle(Boolean(v))}
              aria-labelledby={ids.alerts}
            />
          )}
        </div>
        <NoteLine note={note} />
      </section>

      <section className="border-t border-border/60 py-4 text-xs text-muted-foreground" aria-label="Limits of this demo">
        <p className="font-medium text-foreground">Limits of this demo</p>
        <ul className="mt-1.5 list-disc space-y-1 ps-4">
          <li>Scores change only when the weather data is refreshed, so alerts are rare.</li>
          <li>The server forgets subscriptions when it is redeployed. If alerts stop, turn the switch off and on again.</li>
          <li>Turning alerts on stores the webhook URL on the server until you turn them off.</li>
        </ul>
      </section>
    </div>
  )
}
