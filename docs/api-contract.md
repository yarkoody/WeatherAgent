# API contract

The backend is FastAPI. Every model named here is defined in `app/schemas.py`, which is the source of truth for field names and types.

The mock files in `web/src/mocks/` are illustrative values for UI development. They are not real scores.

## `POST /chat` (streaming, for `useChat`)

The request is the standard `useChat` (AI SDK UI v5) body: `{ id, messages: UIMessage[], trigger?, messageId? }`.

- **Session:** `id` is the chat id, and the server uses it as `session_id`.
- **New message:** only the last user message's text is new. The server keeps the conversation history itself.
- **Length check:** that text must be 1 to 2000 characters, otherwise the server returns 422.

The response is an AI SDK UI message stream (SSE), using the headers from `ai.ui.ai_sdk.UI_MESSAGE_STREAM_HEADERS`. In order:

1. **Tool parts (progress), zero or more:** one per tool call. The tool names are `list_hubs`, `rank_hubs`, `get_hub_risk`, `compare_hubs`, `weather_stat`, `get_active_alerts` and `what_if`. The UI shows them as progress chips while the agent works.
2. **No text parts.** The answer text is never streamed token by token, because numbers are verified before anything is shown.
3. **Exactly one `data-answer` part:** its `data` is a `ChatResponse`, the same shape as `/chat/json` below. The UI renders the answer card from this part.
4. **Finish:** the finish event, then `[DONE]`.

## `POST /chat/json` (non-streaming)

The request is a `ChatRequest`: `{ "session_id": string | null, "message": string (1-2000 chars) }`. The response is a `ChatResponse`:

```json
{
  "session_id": "string",
  "trace_id": "string",
  "grounding": { "status": "pass | retried | failed", "errors": ["string"] },
  "answer": {
    "answer": "markdown string",
    "hubs": ["hub_id"],
    "ranking": ["hub_id"] ,
    "figures": [{ "hub_id": "denver", "label": "string", "value": 11.8, "unit": "%", "source_tool": "weather_stat" }],
    "assumptions": ["string"],
    "uncertainty": "string",
    "data_available": true,
    "in_scope": true
  }
}
```

`ranking` is `null` unless a ranking was asked for.

`follow_ups` holds up to three suggested next questions. They are built by code from the turn (the answer's hubs, its ranking and the tools that ran), never by the model, so each one is in scope and answerable and none contains a number. The UI shows them as one-click chips under the answer.

The UI handles these states:

| Condition | UI state |
|---|---|
| `in_scope: false` | Out of scope |
| `data_available: false` | No data |
| `grounding.status` is `"retried"` | Verified after retry |
| `grounding.status` is `"failed"` | Unverified, shown with a warning |

## `GET /scores`

Returns `ScoreRow[]`, sorted by `priority` in descending order. The fields are `hub_id`, `name`, `region`, `exposure`, `exposure_band`, `priority`, `priority_band` and `top_driver`.

## `GET /hubs`

Returns `Hub[]`.

## `GET /hubs/{hub_id}/score`

Returns one hub's full `HubScore`: both scores with bands, every family with its signals, the top driver, the upgrade categories and the band thresholds. It is the same result as the `get_hub_risk` tool, and no LLM is called. The map uses it for the hub detail view.

- **Names:** `hub_id` is resolved like the tools resolve it: a hub id, a hub city, a nickname, or any city in the hub's metro area (for example `/hubs/new york/score` returns the Newark hub).
- **Resolution note:** when the name was resolved through a nickname or a metro area, the response has an `X-Resolution-Note` header saying how. `HubScore` has no field for it.
- **Errors:** an unknown name, an ambiguous city (for example "portland") or a metro area with no hub returns 404 with `{ "detail": string }`, which says what to use instead.
- **Rate limit:** it is rate-limited like `/what-if`.

## `GET /hubs/{hub_id}/history`

Returns one hub's `HubHistory`: observed disruption days per calendar year and per month (2015 to 2025), the worst year, the peak months and the disruption-day rules. It is the same result as the `get_hub_history` tool, and no LLM is called. The Scores side panel uses it.

Name resolution, the `X-Resolution-Note` header, the 404 errors and the rate limit are the same as for `GET /hubs/{hub_id}/score`.

## `GET /methodology.md`

Returns `docs/METHODOLOGY.md` as `text/markdown`, and 404 with `{ "detail": string }` if the file is missing. It is a static document: no LLM call and no rate limit. The Docker image ships this one file from `docs/`.

## `GET /health`

Returns `{ "status": "ok" }`.

## `POST /alerts/check`

Requires the header `X-Alert-Token: <ALERT_TOKEN>`. Returns `{ "changes": [...], "nws": [...], "delivered": ..., "subscribers": { "sent", "failed", "removed" } }`. Alerts go to `ALERT_WEBHOOK_URL` and then to every subscribed webhook. Optional `?demo_window=2015-2017` rescores the snapshot on those observed years, so an operator can show a real alert (the snapshot's own scores don't change between deploys).

## `GET /alerts/config`

Returns `{ "discord": true, "email": bool }`. `email` is true only when `RESEND_API_KEY` and `ALERT_EMAIL_FROM` are set.

## `POST /send/discord`

Body: `{ "webhook_url" }`. Posts a fixed test message (no user text) with mentions disabled. Returns `{ "status": "sent" }`. Allows 5 requests a minute per IP.

`webhook_url` must be `https://discord.com/api/webhooks/<id>/<token>` or the same on `discordapp.com`, with no other host, port, user info, IP literal, path, query or fragment (otherwise 422). Redirects are not followed, the timeout is 5 s, and the URL is never logged or echoed. Discord's answers map to:

| Discord's answer | Status |
|---|---|
| Unknown webhook | 404 |
| Discord's rate limit | 429 |
| Timeout | 504 |
| Anything else | 502 |

## `POST /alerts/subscribe`, `POST /alerts/unsubscribe`

The body is exactly one of `{ "webhook_url" }` (same check as above) or `{ "email" }` (format checked, lower-cased).

Subscribe sends a confirmation first (a Discord message, or an email through Resend) and stores the target only if it was accepted. It returns `{ "status": "subscribed" | "already_subscribed" }`.

| Case | Status |
|---|---|
| Email with no provider configured (nothing is sent) | 503: "Email alerts need an email provider configured on the server." |
| Caps reached (50 Discord, 20 email) | 409 |

Rate limits: Discord allows 5 a minute per IP. Email subscribe allows 3 a minute per IP and 20 a day per server.

Unsubscribe returns `{ "status": "unsubscribed" | "not_subscribed" }`.

Subscriptions live in SQLite, so a Render redeploy clears them.

## Errors

The body is always `{ "detail": string }`. The status codes:

| Status | Meaning |
|---|---|
| 422 | Validation failed |
| 429 | Rate limit or daily cap reached |
| 401 | Bad alert token |
| 404 | Discord does not know the webhook (`/send/discord`, `/alerts/subscribe`) |
| 409 | Alert subscriptions are full |
| 502, 504 | Discord or the email provider could not be reached, or did not answer within 5 s |
| 503 | Email alerts requested with no email provider configured |
| 404 | Unknown or ambiguous hub name (`GET /hubs/{hub_id}/score` and `/history`) |
| 503 | The model or an upstream service is unavailable |

## `GET /second-opinion`

Returns `SecondOpinion`: the last offline JEV cross-check, read from `data/jev_second_opinion.json`. It returns 404 until the first run. The server never calls JEV live, and JEV never changes scores or rankings.

## `POST /second-opinion/rerun` (developer view only)

This reruns the JEV cross-check and saves the file. It works only where `JEV_RERUN_ENABLED=1` and `TYPESAFE_API_KEY` are both set, which in practice means a local machine. Anywhere else it returns 503 with `{"detail": "...only available when running locally..."}`. Requests to it are rate-limited.
