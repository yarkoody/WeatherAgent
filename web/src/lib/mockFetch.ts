// Mock backend for VITE_USE_MOCKS=1. It replays SSE streams recorded from the real backend
// (app.agent.stream_turn with FakeModel and the real tools), so the UI parses the exact wire format.
// The recorded data is loaded on first use, so it stays out of the production bundle.
const loadMocks = () => import('./mockData')

export type MockScenario = 'ranking' | 'compare' | 'weather' | 'alerts' | 'nodata' | 'outofscope' | 'failed' | 'resolution' | 'badyear' | 'history'

const IN_SCOPE =
  /hub|risk|expos|new york|bad year|priorit|rank|weather|snow|rain|flood|storm|hurricane|winter|wind|freez|alert|invest|chicago|minneapolis|detroit|indianapolis|kansas|columbus|dallas|houston|miami|atlanta|memphis|denver|phoenix|los angeles|newark|midwest|south|west|northeast/i

/** Picks the recorded scenario that best fits the question. */
export function pickScenario(text: string): MockScenario {
  const t = text.toLowerCase()
  if (!IN_SCOPE.test(t)) return 'outofscope'
  if (/how exposed is houston|unverified/.test(t)) return 'failed' // demo of a failed grounding check
  if (/history|historical|seasonal|by month|each year/.test(t)) return 'history'
  if (/new york|nyc/.test(t)) return 'resolution' // a city resolved to a hub through its metro area
  if (/bad[ -]year|worst year|1 in 20/.test(t)) return 'badyear'
  if (/alert|warning|right now|today/.test(t)) return 'alerts'
  if (/compare|\bvs\.?\b|versus/.test(t)) return 'compare'
  if (/20(2[6-9]|[3-9]\d)/.test(t)) return 'nodata'
  if (/how many|percent|%|days did|in 20\d\d/.test(t)) return 'weather'
  return 'ranking'
}

function sseEvents(raw: string): string[] {
  return raw
    .split('\n\n')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => `${e}\n\n`)
}

const sleep = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    })
  })

/** Delay before each event, so tool chips visibly progress like a real turn. */
function delayFor(event: string): number {
  if (event.includes('"tool-input-start"')) return 350
  if (event.includes('"tool-output-available"')) return 650
  if (event.includes('"data-answer"')) return 900
  return 40
}

let replays = 0

/** Each replay gets its own assistant message id; reusing the recorded one would merge repeated answers into one message. */
export function withFreshMessageId(raw: string): string {
  replays += 1
  return raw.replace(/"messageId": "[^"]+"/, `"messageId": "mock-msg-${replays}-${Date.now().toString(36)}"`)
}

export function replayStream(raw: string, signal?: AbortSignal | null, speed = 1): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const events = sseEvents(raw)
  return new ReadableStream({
    async start(controller) {
      try {
        for (const event of events) {
          if (speed > 0) await sleep(delayFor(event) / speed, signal)
          controller.enqueue(encoder.encode(event))
        }
        controller.close()
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

function lastUserText(body: unknown): string {
  const messages = (body as { messages?: { role: string; parts?: { type: string; text?: string }[] }[] })?.messages ?? []
  const last = [...messages].reverse().find((m) => m.role === 'user')
  return last?.parts?.filter((p) => p.type === 'text').map((p) => p.text ?? '').join(' ') ?? ''
}

export const mockFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const path = new URL(url, 'http://mock.local').pathname
  if (path === '/chat') {
    const body = init?.body ? JSON.parse(String(init.body)) : {}
    const scenario = pickScenario(lastUserText(body))
    const { MOCK_STREAMS } = await loadMocks()
    return new Response(replayStream(withFreshMessageId(MOCK_STREAMS[scenario]), init?.signal), {
      headers: { 'Content-Type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' },
    })
  }
  if (path === '/methodology.md') {
    await sleep(150)
    return new Response((await loadMocks()).methodology, { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } })
  }
  if (path === '/hubs') {
    await sleep(150)
    return Response.json((await loadMocks()).hubs)
  }
  const hubHistory = /^\/hubs\/([a-z_]+)\/history$/.exec(path)
  if (hubHistory) {
    await sleep(200)
    const history = (await loadMocks()).hubHistories[hubHistory[1]]
    return history ? Response.json(history) : Response.json({ detail: `Unknown hub ${hubHistory[1]}` }, { status: 404 })
  }
  const hubScore = /^\/hubs\/([a-z_]+)\/score$/.exec(path)
  if (hubScore) {
    await sleep(150)
    const score = (await loadMocks()).hubScores[hubScore[1]]
    return score ? Response.json(score) : Response.json({ detail: `Unknown hub ${hubScore[1]}` }, { status: 404 })
  }
  if (path === '/scores') {
    await sleep(250)
    return Response.json((await loadMocks()).scores)
  }
  if (path === '/what-if') {
    // Mock: real what-if results recorded from the scoring code (baseline, and one analyst example).
    await sleep(200)
    const { whatIf } = await loadMocks()
    const body = init?.body ? (JSON.parse(String(init.body)) as { family_weights?: object; upgrade_costs?: unknown[] }) : {}
    const empty = !body.family_weights && !body.upgrade_costs?.length
    return Response.json(empty ? whatIf.baseline : whatIf.example)
  }
  if (path === '/alerts/config') return Response.json({ discord: true, email: false }) // mock mode has no email provider
  if (path === '/send/discord' || path === '/alerts/subscribe' || path === '/alerts/unsubscribe') {
    // Mock mode never contacts Discord: it answers as the backend would after a successful post.
    await sleep(300)
    const status = { '/send/discord': 'sent', '/alerts/subscribe': 'subscribed', '/alerts/unsubscribe': 'unsubscribed' }[path]
    return Response.json({ status })
  }
  return Response.json({ detail: `No mock for ${path}` }, { status: 404 })
}

export const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === '1'
/** fetch for every API call; the mock switch is read per call so tests can turn it on. */
export const apiFetch: typeof fetch = (input, init) =>
  import.meta.env.VITE_USE_MOCKS === '1' ? mockFetch(input, init) : fetch(input, init)
