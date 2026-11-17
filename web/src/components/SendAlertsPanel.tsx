// "Send & alerts": the Discord webhook, a default email address and score-change alerts, in one side sheet.
// Opened from the sidebar, or by a send button when nothing is configured (openSendSettings()).
import { CheckIcon, LoaderCircleIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  isDiscordWebhook,
  isEmail,
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
  const [focus, setFocus] = useState<'discord' | 'email' | undefined>()
  useEffect(
    () =>
      onOpenSendSettings((f) => {
        setFocus(f)
        setOpen(true)
      }),
    [],
  )
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetContent side="right" className="glass gap-0 overflow-y-auto p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-md" aria-describedby={undefined}>
        <SheetHeader className="border-b border-border/60 px-5 py-4">
          <SheetTitle className="heading-tight text-lg">Send &amp; alerts</SheetTitle>
          <SheetDescription>Where "Send to Discord" and "Send by email" go, and score-change alerts.</SheetDescription>
        </SheetHeader>
        {open && <SendAlertsPanel focus={focus} />}
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

export function SendAlertsPanel({ focus }: { focus?: 'discord' | 'email' }) {
  const ids = { hook: useId(), hookHelp: useId(), email: useId(), emailHelp: useId(), alerts: useId(), alertsHelp: useId() }
  const initial = useRef(loadSendSettings()).current
  const [hook, setHook] = useState(initial.discordWebhook)
  const [email, setEmail] = useState(initial.email)
  const [alerts, setAlerts] = useState(initial.alerts)
  const [hookNote, setHookNote] = useState<Note>(null)
  const [alertNote, setAlertNote] = useState<Note>(null)
  const [busy, setBusy] = useState<'test' | 'alerts' | null>(null)
  const saved = loadSendSettings()
  const hookValid = isDiscordWebhook(hook.trim())
  const hookInvalid = hook.trim() !== '' && !hookValid
  const emailInvalid = email.trim() !== '' && !isEmail(email.trim())

  async function changeHook(value: string) {
    setHook(value)
    const url = value.trim()
    if (url !== '' && !isDiscordWebhook(url)) return
    const previous = loadSendSettings()
    if (url === previous.discordWebhook) return
    // A subscription belongs to one webhook: a new (or cleared) webhook ends the old subscription.
    if (previous.alerts && previous.discordWebhook) {
      void unsubscribeAlerts(previous.discordWebhook)
      setAlerts(false)
      setAlertNote({ tone: 'info', text: 'Alerts were turned off because the webhook changed. Turn them on again for the new one.' })
    }
    saveSendSettings({ discordWebhook: url, alerts: false })
    setHookNote(url ? { tone: 'ok', text: 'Saved in this browser.' } : { tone: 'info', text: 'Webhook removed from this browser.' })
  }

  function changeEmail(value: string) {
    setEmail(value)
    const address = value.trim()
    if (address === '' || isEmail(address)) saveSendSettings({ email: address })
  }

  async function test() {
    setBusy('test')
    const res = await sendTestMessage(saved.discordWebhook)
    setBusy(null)
    setHookNote(res.ok ? { tone: 'ok', text: 'Test message sent. Check the Discord channel.' } : { tone: 'error', text: res.message })
  }

  async function toggleAlerts(on: boolean) {
    const url = saved.discordWebhook
    if (!url) return
    setBusy('alerts')
    const res = on ? await subscribeAlerts(url) : await unsubscribeAlerts(url)
    setBusy(null)
    if (!res.ok) {
      setAlertNote({ tone: 'error', text: res.message })
      return
    }
    setAlerts(on)
    saveSendSettings({ alerts: on })
    setAlertNote(
      on
        ? { tone: 'ok', text: 'Subscribed. A confirmation was posted to the channel.' }
        : { tone: 'info', text: 'Unsubscribed. This webhook no longer gets alerts.' },
    )
  }

  return (
    <div className="space-y-0 px-5 py-2 text-sm">
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
          autoFocus={focus === 'discord'}
          placeholder="https://discord.com/api/webhooks/…"
          value={hook}
          onChange={(e) => void changeHook(e.target.value)}
          aria-invalid={hookInvalid || undefined}
          aria-describedby={ids.hookHelp}
          className="mt-1"
        />
        {hookInvalid && (
          <p className="mt-1 text-xs text-band-high-text">
            Paste a Discord webhook URL: it starts with https://discord.com/api/webhooks/.
          </p>
        )}
        <p id={ids.hookHelp} className="mt-2 text-xs text-muted-foreground">
          In Discord: channel settings, Integrations, Webhooks, New Webhook, Copy Webhook URL. The URL is kept in this browser.
          Anyone with it can post to that channel, so treat it like a password.
        </p>
        <div className="mt-3">
          <Button size="sm" variant="outline" disabled={!saved.discordWebhook || busy !== null} onClick={() => void test()}>
            {busy === 'test' ? <LoaderCircleIcon className="animate-spin" /> : null}
            Send test message
          </Button>
        </div>
        <NoteLine note={hookNote} />
      </section>

      <section className="border-t border-border/60 py-4" aria-labelledby={`${ids.email}-title`}>
        <h3 id={`${ids.email}-title`} className="font-medium">
          Email
        </h3>
        <label htmlFor={ids.email} className="mt-2 block text-xs text-muted-foreground">
          Default address (optional)
        </label>
        <Input
          id={ids.email}
          type="email"
          autoComplete="email"
          autoFocus={focus === 'email'}
          placeholder="name@example.com"
          value={email}
          onChange={(e) => changeEmail(e.target.value)}
          aria-invalid={emailInvalid || undefined}
          aria-describedby={ids.emailHelp}
          className="mt-1"
        />
        {emailInvalid && <p className="mt-1 text-xs text-band-high-text">That does not look like an email address.</p>}
        <p id={ids.emailHelp} className="mt-2 text-xs text-muted-foreground">
          "Send by email" opens your own mail app with the answer filled in{email.trim() && !emailInvalid ? ', addressed to this address' : ''}.
          This site never sends email itself.
        </p>
      </section>

      <section className="border-t border-border/60 py-4" aria-labelledby={ids.alerts}>
        <div className="flex items-center justify-between gap-3">
          <p id={ids.alerts} className="font-medium">
            Alert me when a hub's score changes
          </p>
          {busy === 'alerts' ? (
            <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" aria-label="Updating" />
          ) : (
            <Switch
              checked={alerts}
              disabled={!saved.discordWebhook}
              onCheckedChange={(v) => void toggleAlerts(Boolean(v))}
              aria-labelledby={ids.alerts}
              aria-describedby={ids.alertsHelp}
            />
          )}
        </div>
        <div id={ids.alertsHelp} className="mt-2 space-y-1.5 text-xs text-muted-foreground">
          <p>
            {saved.discordWebhook
              ? 'Posts to the Discord webhook above when a hub’s score moves 5 points or more, or its level changes, and for severe live NWS alerts at a hub.'
              : 'Add a Discord webhook above first. Alerts go to that channel.'}
          </p>
          <p>Limits of this demo:</p>
          <ul className="list-disc space-y-1 ps-4">
            <li>Scores change only when the weather data is refreshed, so alerts are rare.</li>
            <li>The server forgets subscriptions when it is redeployed. If alerts stop, turn this off and on again.</li>
            <li>Turning this on stores the webhook URL on the server until you turn it off.</li>
          </ul>
        </div>
        {alerts && (
          <p className="mt-2 flex items-center gap-1 text-xs text-band-low-text">
            <CheckIcon className="size-3.5" aria-hidden="true" />
            On for this webhook
          </p>
        )}
        <NoteLine note={alertNote} />
      </section>
    </div>
  )
}
