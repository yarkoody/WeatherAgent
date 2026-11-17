// Streams recorded from the real formula-v2 backend (app.agent.stream_turn, FakeModel, real tools; NWS alerts stubbed).
// `failed` is a turn whose answer cites a number no tool returned, twice, so grounding fails.
import alerts from '../mocks/chat-stream-alerts.sse?raw'
import badyear from '../mocks/chat-stream-badyear.sse?raw'
import compare from '../mocks/chat-stream-compare.sse?raw'
import failed from '../mocks/chat-stream-failed.sse?raw'
import nodata from '../mocks/chat-stream-nodata.sse?raw'
import outofscope from '../mocks/chat-stream-outofscope.sse?raw'
import resolution from '../mocks/chat-stream-resolution.sse?raw'
import weather from '../mocks/chat-stream-weather.sse?raw'
import ranking from '../mocks/chat-stream.sse?raw'
import type { MockScenario } from './mockFetch'
import scoresJson from '../mocks/scores.json'
import secondOpinionJson from '../mocks/second-opinion.json'
import whatIfJson from '../mocks/what-if.json'
import history from '../mocks/chat-stream-history.sse?raw'
import type { ScoreRow, SecondOpinion, WhatIfResult } from './types'

export const MOCK_STREAMS: Record<MockScenario, string> = { ranking, compare, weather, alerts, nodata, outofscope, failed, resolution, badyear, history }
export const scores = scoresJson as ScoreRow[]

/** Synthetic JEV cross-check for UI development (not a real JEV run): real formula bands, a few deliberate disagreements. */
export const secondOpinion = secondOpinionJson as SecondOpinion

/** Recorded from scoring.what_if: the default inputs, and hurricane x3 / flood x1.5 with three upgrade costs. */
export const whatIf = whatIfJson as { baseline: WhatIfResult; example: WhatIfResult }
