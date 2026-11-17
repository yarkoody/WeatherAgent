// Streams recorded from the real backend (app.agent.stream_turn, FakeModel, real tools; NWS alerts stubbed).
// `failed` is a turn whose answer cites a number no tool returned, twice, so grounding fails.
import alerts from '../mocks/chat-stream-alerts.sse?raw'
import compare from '../mocks/chat-stream-compare.sse?raw'
import failed from '../mocks/chat-stream-failed.sse?raw'
import nodata from '../mocks/chat-stream-nodata.sse?raw'
import outofscope from '../mocks/chat-stream-outofscope.sse?raw'
import weather from '../mocks/chat-stream-weather.sse?raw'
import ranking from '../mocks/chat-stream.sse?raw'
import type { MockScenario } from './mockFetch'
import scoresJson from '../mocks/scores.json'
import type { ScoreRow } from './types'

export const MOCK_STREAMS: Record<MockScenario, string> = { ranking, compare, weather, alerts, nodata, outofscope, failed }
export const scores = scoresJson as ScoreRow[]
