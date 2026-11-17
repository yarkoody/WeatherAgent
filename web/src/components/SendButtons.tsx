// "Send to Discord" and "Send by email" on an answer, next to "Export report".
// Both use what the "Send & alerts" panel saved; Discord opens that panel when no webhook is set.
import { CheckIcon, LoaderCircleIcon, MailIcon, SendIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, buttonVariants } from '@/components/ui/button'
import { discordMessage, loadSendSettings, mailtoLink, onSendSettingsChange, openSendSettings, sendToDiscord } from '@/lib/send'
import type { ChatResponse } from '@/lib/types'

type State = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'error'; message: string }

export function SendButtons({ response, question, dataAsOf }: { response: ChatResponse; question?: string; dataAsOf?: string }) {
  const [settings, setSettings] = useState(loadSendSettings)
  useEffect(() => onSendSettingsChange(() => setSettings(loadSendSettings())), [])
  const [state, setState] = useState<State>({ kind: 'idle' })

  useEffect(() => {
    if (state.kind !== 'sent') return
    const t = setTimeout(() => setState({ kind: 'idle' }), 4000)
    return () => clearTimeout(t)
  }, [state])

  async function discord() {
    const webhook = loadSendSettings().discordWebhook
    if (!webhook) return openSendSettings('discord')
    setState({ kind: 'sending' })
    const res = await sendToDiscord(webhook, discordMessage(response, question, dataAsOf))
    setState(res.ok ? { kind: 'sent' } : { kind: 'error', message: res.message })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="xs"
        className="text-muted-foreground"
        disabled={state.kind === 'sending'}
        onClick={() => void discord()}
        title={settings.discordWebhook ? 'Post this answer to your Discord channel' : 'Set up a Discord webhook first'}
      >
        {state.kind === 'sending' ? <LoaderCircleIcon className="animate-spin" /> : state.kind === 'sent' ? <CheckIcon /> : <SendIcon />}
        {state.kind === 'sent' ? 'Sent to Discord' : 'Send to Discord'}
      </Button>
      {/* A link, not a button: the mail app opens with the subject and body filled in. Nothing is sent by this site. */}
      <a
        href={mailtoLink(response, question, dataAsOf, settings.email)}
        className={buttonVariants({ variant: 'ghost', size: 'xs', className: 'text-muted-foreground' })}
      >
        <MailIcon />
        Send by email
      </a>
      {state.kind === 'error' && (
        <p role="alert" className="basis-full text-right text-xs text-band-high-text">
          {state.message}{' '}
          <button type="button" className="underline underline-offset-2" onClick={() => openSendSettings('discord')}>
            Open Send &amp; alerts
          </button>
        </p>
      )}
    </>
  )
}
