import { apiFetch } from './mockFetch'

export interface ChatErrorView {
  title: string
  detail?: string
  canRetry: boolean
}

/**
 * fetch for /chat. The AI SDK turns a non-2xx response into an Error whose message is the body text,
 * without the status code, so on errors the body is rewritten to {status, detail}.
 */
export const chatFetch: typeof fetch = async (input, init) => {
  const res = await apiFetch(input, init)
  if (res.ok) return res
  const text = await res.text().catch(() => '')
  let detail: string | undefined
  try {
    detail = (JSON.parse(text) as { detail?: unknown }).detail as string | undefined
  } catch {
    detail = text || undefined
  }
  return new Response(JSON.stringify({ status: res.status, detail: typeof detail === 'string' ? detail : undefined }), {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** What to tell the analyst for a failed /chat request. */
export function describeChatError(error: Error): ChatErrorView {
  let status: number | undefined
  let detail: string | undefined
  try {
    const body = JSON.parse(error.message) as { status?: number; detail?: string }
    status = body.status
    detail = body.detail
  } catch {
    /* network error or a non-JSON message */
  }
  switch (status) {
    case 422:
      return { title: 'The question could not be sent. Keep it between 1 and 2,000 characters.', detail, canRetry: false }
    case 429:
      return { title: 'Request limit reached. Wait a minute, or come back tomorrow if the daily limit is used up.', detail, canRetry: false }
    case 503:
      return { title: 'The analysis service is temporarily unavailable.', detail, canRetry: true }
    case undefined:
      return { title: 'The analysis service did not respond. Check your connection or that the backend is running.', canRetry: true }
    default:
      return { title: `The request failed (HTTP ${status}).`, detail, canRetry: true }
  }
}
