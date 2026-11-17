// "Send & alerts": score-change alerts to a Discord webhook or an email address, in one side sheet opened from the
// sidebar. Email needs a provider configured on the server; without one the email controls are disabled.
import { CheckIcon, LoaderCircleIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import {
  EMAIL_DISABLED,
  fetchAlertConfig,
  isDiscordWebhook,
  isEmail,
  loadSendSettings,
  onOpenSendSettings,
  saveSendSettings,
  sendTestMessage,
  subscribeAlerts,
  unsubscribeAlerts,
  type Target,
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
          <SheetDescription>Get a message when a hub's risk score changes.</SheetDescription>
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

/** One alert switch: subscribe or unsubscribe a target, and remember the result in this browser. */
function AlertSwitch({
  label,
  on,
  disabled,
  busy,
  onToggle,
}: {
  label: string
  on: boolean
  disabled: boolean
  busy: boolean
  onToggle: (on: boolean) => void
}) {
  const id = useId()
  return (
    <div className="mt-3 flex items-center justify-between gap-3">
      <span id={id} className="text-sm">
        {label}
      </span>
      {busy ? (
        <LoaderCircleIcon className="size-4 animate-spin text-muted-foreground" aria-label="Updating" />
      ) : (
        <Switch checked={on} disabled={disabled} onCheckedChange={(v) => onToggle(Boolean(v))} aria-labelledby={id} />
      )}
    </div>
  )
}

export function SendAlertsPanel() {
  const ids = { hook: useId(), hookHelp: useId(), email: useId(), emailHelp: useId() }
  const initial = useRef(loadSendSettings()).current
  const [hook, setHook] = useState(initial.discordWebhook)
  const [email, setEmail] = useState(initial.email)
  const [saved, setSaved] = useState(initial)
  const [emailEnabled, setEmailEnabled] = useState<boolean | null>(null)
  const [hookNote, setHookNote] = useState<Note>(null)
  const [emailNote, setEmailNote] = useState<Note>(null)
  const [busy, setBusy] = useState<'test' | 'discord' | 'email' | null>(null)
  const hookValid = isDiscordWebhook(hook.trim())
  const hookInvalid = hook.trim() !== '' && !hookValid
  const emailInvalid = email.trim() !== '' && !isEmail(email.trim())

  useEffect(() => {
    let live = true
    void fetchAlertConfig().then((c) => live && setEmailEnabled(c.email))
    return () => {
      live = false
    }
  }, [])

  function save(update: Parameters<typeof saveSendSettings>[0]) {
    setSaved(saveSendSettings(update))
  }

  /** A subscription belongs to one webhook or address: changing it ends the old subscription. */
  function changeTarget(kind: 'discord' | 'email', value: string) {
    const isDiscord = kind === 'discord'
    ;(isDiscord ? setHook : setEmail)(value)
    const next = value.trim()
    if (next !== '' && !(isDiscord ? isDiscordWebhook(next) : isEmail(next))) return
    const current = loadSendSettings()
    const previous = isDiscord ? current.discordWebhook : current.email
    if (next === previous) return
    const setNote = isDiscord ? setHookNote : setEmailNote
    if (isDiscord ? current.discordAlerts : current.emailAlerts) {
      void unsubscribeAlerts(isDiscord ? { webhook_url: previous } : { email: previous })
      setNote({ tone: 'info', text: `Alerts were turned off because the ${isDiscord ? 'webhook' : 'address'} changed. Turn them on again for the new one.` })
    } else {
      setNote(next ? { tone: 'ok', text: 'Saved in this browser.' } : null)
    }
    save(isDiscord ? { discordWebhook: next, discordAlerts: false } : { email: next, emailAlerts: false })
  }

  async function test() {
    setBusy('test')
    const res = await sendTestMessage(saved.discordWebhook)
    setBusy(null)
    setHookNote(res.ok ? { tone: 'ok', text: 'Test message sent. Check the Discord channel.' } : { tone: 'error', text: res.message })
  }

  async function toggle(kind: 'discord' | 'email', on: boolean) {
    const target: Target = kind === 'discord' ? { webhook_url: saved.discordWebhook } : { email: saved.email }
    const setNote = kind === 'discord' ? setHookNote : setEmailNote
    setBusy(kind)
    const res = on ? await subscribeAlerts(target) : await unsubscribeAlerts(target)
    setBusy(null)
    if (!res.ok) return setNote({ tone: 'error', text: res.message })
    save(kind === 'discord' ? { discordAlerts: on } : { emailAlerts: on })
    const where = kind === 'discord' ? 'A confirmation was posted to the channel.' : 'A confirmation email is on its way.'
    setNote(on ? { tone: 'ok', text: `Subscribed. ${where}` } : { tone: 'info', text: 'Unsubscribed. No more alerts here.' })
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
          onChange={(e) => changeTarget('discord', e.target.value)}
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
        <AlertSwitch
          label="Alert this channel when a hub's score changes"
          on={saved.discordAlerts}
          disabled={!saved.discordWebhook || busy !== null}
          busy={busy === 'discord'}
          onToggle={(on) => void toggle('discord', on)}
        />
        <NoteLine note={hookNote} />
      </section>

      <section className="border-t border-border/60 py-4" aria-labelledby={`${ids.email}-title`}>
        <h3 id={`${ids.email}-title`} className="font-medium">
          Email
        </h3>
        <label htmlFor={ids.email} className="mt-2 block text-xs text-muted-foreground">
          Email address
        </label>
        <Input
          id={ids.email}
          type="email"
          autoComplete="email"
          placeholder="name@example.com"
          value={email}
          disabled={emailEnabled !== true}
          onChange={(e) => changeTarget('email', e.target.value)}
          aria-invalid={emailInvalid || undefined}
          aria-describedby={ids.emailHelp}
          className="mt-1"
        />
        {emailInvalid && <p className="mt-1 text-xs text-band-high-text">That does not look like an email address.</p>}
        <p id={ids.emailHelp} className="mt-2 text-xs text-muted-foreground">
          {emailEnabled === false ? EMAIL_DISABLED : emailEnabled === null ? 'Checking whether the server can send email…' : 'Alerts are sent from this server. A confirmation email goes out when you turn them on.'}
        </p>
        <AlertSwitch
          label="Email me when a hub's score changes"
          on={saved.emailAlerts}
          disabled={emailEnabled !== true || !saved.email || busy !== null}
          busy={busy === 'email'}
          onToggle={(on) => void toggle('email', on)}
        />
        <NoteLine note={emailNote} />
      </section>

      <section className="border-t border-border/60 py-4 text-xs text-muted-foreground" aria-label="Limits of this demo">
        <p className="font-medium text-foreground">Limits of this demo</p>
        <ul className="mt-1.5 list-disc space-y-1 ps-4">
          <li>Scores change only when the weather data is refreshed, so alerts are rare.</li>
          <li>The server forgets subscriptions when it is redeployed. If alerts stop, turn the switch off and on again.</li>
          <li>Turning alerts on stores the webhook URL or address on the server until you turn them off.</li>
        </ul>
        {(saved.discordAlerts || saved.emailAlerts) && (
          <p className="mt-2 flex items-center gap-1 text-band-low-text">
            <CheckIcon className="size-3.5" aria-hidden="true" />
            Alerts are on for {[saved.discordAlerts && 'Discord', saved.emailAlerts && 'email'].filter(Boolean).join(' and ')}.
          </p>
        )}
      </section>
    </div>
  )
}
