# Weather Risk Intelligence Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement your track task-by-task. Steps use checkbox (`- [ ]`) syntax. You work in a folder shared with other sessions: touch only your track's files, do not commit, do not switch branches, do not edit `pyproject.toml`, `uv.lock` or `app/schemas.py` (ask the orchestrator session if you need a change there).

**Goal:** A Python agent that ranks, compares and explains weather-disruption exposure and investment priority for 15 US logistics hubs, with deterministic scoring, a grounded JSON-schema answer, a React chat UI with voice, score-change alerts, evals, and a Render deployment.

**Architecture:** FastAPI serves `/chat` (AI SDK UI stream for `useChat`) and `/chat/json`, both running one agent: a Vercel AI SDK for Python `Agent` subclass with a custom `loop()` (max 6 tool rounds, grounding retry) on an OpenAI model. Tools call pure scoring functions over a committed JSON data snapshot. The final answer is parsed into a Pydantic `AgentAnswer` and checked by a deterministic grounding step before it is returned. SQLite stores conversations, score history and alerts; JSONL traces log every step.

**Tech Stack:** Python 3.12+, uv, FastAPI, Pydantic v2, Vercel AI SDK for Python (`ai` 0.9, OpenAI provider; fallback: OpenAI Python SDK Responses API), httpx, PyYAML, pytest, respx; React + TypeScript + Vite + Tailwind CSS + `@ai-sdk/react` (`useChat`); Render; GitHub Actions.

**Spec:** `docs/specs/2026-11-17-weather-risk-agent-design.md` (revision 3). Read it first.

## Global Constraints

- Every number shown to the user comes from scoring code over the snapshot, from a live NWS call, or from analyst-supplied what-if inputs. Never from the LLM.
- Scoring is deterministic: same snapshot and config give byte-identical rankings. Ties break by `hub_id` ascending.
- Normalization is `min(raw / cap, 1.0) * 100` with fixed caps from `ScoringConfig`; never min-max across hubs.
- Hub ids are lowercase slugs: `chicago, minneapolis, detroit, indianapolis, kansas_city, columbus, dallas, houston, miami, atlanta, memphis, denver, phoenix, los_angeles, newark`.
- Hazard families: `winter, flood, hurricane, severe_storm`. Score kinds: `exposure, priority`.
- Bands: `low` < 35, `medium` 35 to < 60, `high` >= 60.
- Tests never touch the network or need an API key.
- No secrets in git. `.env` is gitignored. `.env.example` lists every variable with no values.
- All user-facing text and docs in English.
- Percentages are always on a 0-100 scale (11.8 means 11.8%), never fractions.
- Run only your own track's test files (`uv run pytest tests/test_<yours>.py`); other tracks' half-finished tests share the folder.
- Usage budget is shared (Pro plan): no broad explorations, no full-suite reruns in loops, no real-model calls except where a step says so.

## Review Focus

1. A hub name typed differently ("Kansas City", "KC", "dallas hub") must resolve via `list_hubs` or produce the structured unknown-hub error, never a crash. Test: `test_tools.py::test_unknown_hub_returns_structured_error`.
2. A year with partial data (2025 is complete; a future year like 2026 is not) must return `data_available: false`, not a percentage over a partial year. Test: `test_scoring.py::test_weather_stat_rejects_year_outside_snapshot`.
3. An LLM answer that writes "43%" in prose but cites 11.8 in figures must fail grounding. Test: `test_grounding.py::test_number_in_text_not_in_figures_fails`.
4. An empty or very long user message (0 chars, 5,000 chars) must get a 422 from `/chat`, not reach the model. Test: `test_api.py::test_chat_rejects_empty_and_oversized_message`.
5. Two parallel `/chat` calls on the same `session_id` must not lose a turn. Test: `test_store.py::test_concurrent_appends_keep_both_turns` (store uses one connection per call and an `IMMEDIATE` transaction).

---

## Contracts (fixed; every track codes against these)

### `data/hubs.json`
List of objects: `{"id": str, "name": str, "city": str, "state": str, "region": "Midwest"|"South"|"West"|"Northeast", "lat": float, "lon": float, "county_fips": str}`. County FIPS used for the probe on 2026-11-17: chicago 17031, minneapolis 27053, detroit 26163, indianapolis 18097, kansas_city 29095, columbus 39049, dallas 48113, houston 48201, miami 12086, atlanta 13121, memphis 47157, denver 08031, phoenix 04013, los_angeles 06037, newark 34013.

### `data/snapshot/`
- `nri.json`: `{"fetched_at": iso, "source": url, "counties": {fips: {"HRCN_AFREQ", "IFLD_AFREQ", "CFLD_AFREQ", "WNTW_AFREQ", "ISTM_AFREQ", "CWAV_AFREQ", "TRND_AFREQ", "SWND_AFREQ", "HAIL_AFREQ", "POPULATION", "AREA", "RESL_SCORE": float|null}}}`
- `weather.json`: `{"fetched_at": iso, "source": url, "start": "2015-01-01", "end": "2025-12-31", "hubs": {hub_id: {"time": [date...], "snowfall_sum": [...], "precipitation_sum": [...], "wind_gusts_10m_max": [...], "temperature_2m_min": [...]}}}`. Units: cm, mm, km/h, °C.
- Decision (narrows the spec): the snapshot covers 2015 to 2025, and `weather_stat` answers only those years; other years return `data_available: false`. No live Open-Meteo calls at question time.

### `app/schemas.py` (the only contract; written; orchestrator-owned)
Read the file. Models: `Hub, Signal, FamilyScore, BandThresholds, HubScore, HubComparison, RankedHub, Ranking, PerMillionHub, WeatherStat, NwsAlert, ActiveAlerts, FamilyWeights, HubCost, WhatIfInput, WhatIfResult, ScoreRow, ToolError, Figure, AgentAnswer, Grounding, ChatRequest, ChatResponse`, plus the Literal types `Region, Family, Hazard, ScoreKind, Band, Metric`. If this plan and `schemas.py` ever disagree, `schemas.py` wins; ask the orchestrator for changes.

### Scoring API (`app/scoring.py`, Track A)
- `load_hubs(path: Path = DATA_DIR / "hubs.json") -> list[Hub]`
- `load_snapshot(dir: Path = DATA_DIR / "snapshot") -> Snapshot` (a dataclass holding `nri` and `weather` dicts)
- `class ScoringConfig(BaseModel)` with every weight, cap and threshold from spec section 6 as a field with that default; `DEFAULT_CONFIG = ScoringConfig()`
- `score_all(hubs, snapshot, config=DEFAULT_CONFIG) -> dict[str, HubScore]`
- `rank(scores, hubs, kind: ScoreKind, hazard: Hazard = "overall", region: Region | None = None, top_n: int = 15) -> Ranking`; `hazard` other than overall is only valid with `kind="exposure"` (raise `ValueError`)
- `score_rows(scores, hubs) -> list[ScoreRow]` sorted by priority descending (used by `/scores` and alerts)
- Every `HubScore`, `Ranking`, `WeatherStat`, `WhatIfResult` carries `band_thresholds` (where defined) and `data_as_of` (snapshot `fetched_at` date)
- `weather_stat(snapshot, hub_id, metric, year) -> WeatherStat`; raises `DataUnavailable(msg)` for unknown year or hub
- `what_if(hubs, snapshot, inputs: WhatIfInput, config=DEFAULT_CONFIG) -> WhatIfResult`: re-ranks **priority** with the overridden family weights (renormalized to sum 1); with `upgrade_costs`, also `per_million_ranking` (priority / cost, 2 decimals). Signal-level weight overrides are out of scope.
- `UPGRADE_CATEGORIES: dict[Family, list[str]]`

### Tools (`app/tools.py`, Track A)
- Seven plain `async def` functions with fully type-annotated parameters (Literal types from `schemas.py`, except `hub_id`/`hub_ids` typed `str` so an unknown hub reaches our `ToolError` instead of a schema rejection) and a docstring that becomes the tool description. Returns: `list_hubs -> list[Hub]`, `rank_hubs -> Ranking`, `get_hub_risk -> HubScore`, `compare_hubs -> HubComparison`, `weather_stat -> WeatherStat`, `get_active_alerts -> ActiveAlerts`, `what_if -> WhatIfResult`: `list_hubs, rank_hubs, get_hub_risk, compare_hubs, weather_stat, get_active_alerts, what_if` (args per spec section 7). Each validates its own arguments (Pydantic `validate_call` or an args model) and returns a Pydantic model, a list of models, or `ToolError`. Tools never raise.
- `TOOL_FUNCTIONS: list[Callable[..., Awaitable[Any]]]` (all seven, in that order).
- `ARG_MODELS: dict[str, type[BaseModel]]`: one strict args model per tool (used for validation and by the fallback loop to build strict schemas).
- `run_tool(name: str, arguments_json: str) -> dict`: parse, validate, call, `model_dump(mode="json")`. Unknown tool, invalid JSON, validation error, `DataUnavailable`, upstream failure all return `ToolError(...).model_dump()`.
- Track B does not use `@ai.tool` (its generated schemas are not strict: verified in the review). It builds each tool as `ai.AgentTool` with `spec.params = openai.lib._pydantic.to_strict_json_schema(ARG_MODELS[name])`, a function that calls `run_tool`, and no SDK validator; the spike confirms the exact constructor.

### Agent API (`app/agent.py`, Track B)
- `class WeatherAgent(ai.Agent)` overriding `loop()`: at most `max_steps=6` tool rounds; then one final call `ai.stream(model, msgs, tools=[], output_type=AgentAnswer)`; grounding check; on failure one retry using the exported constant `GROUNDING_RETRY_TEMPLATE` (FakeModel scripts must match user text exactly); the retry message is not stored in history; the result is kept on the agent instance (not yielded as a custom event, which `to_stream` cannot handle).
- `get_model() -> model`: `ai.get_model(f"openai:{OPENAI_MODEL}")`; tests pass `ai.testing.FakeModel`.
- `async run_turn(message: str, session_id: str | None, *, model, store: Store, tracer: Tracer, max_steps: int = 6) -> ChatResponse` (non-streaming, used by `/chat/json` and evals)
- `async stream_turn(...) -> AsyncIterator[str]`: filter out `TextStart/TextDelta/TextEnd` events (answer text is never streamed), pass the rest to `ai.ui.ai_sdk.to_stream`, hold back its finish event, emit `format_sse(UIDataEvent(data_type="answer", data=<ChatResponse JSON>))`, then the finish event, then `format_done_sse()`. Do not use `to_sse` (it emits finish and `[DONE]` itself, leaving no slot for the answer).
- Fallback if the spike fails: the same two functions implemented with the OpenAI Responses API directly, emitting the same SSE chunk shapes by hand. Nothing outside `agent.py` changes.

### API (`app/api.py`, Track B)
- `create_app(model=None, store=None) -> FastAPI` (defaults: `agent.get_model()` resolved lazily on first request, `Store(DATA_DIR / "app.db")`)
- `POST /chat` (body: `useChat` request `{id, messages: UIMessage[], ...}`; the body model allows extra fields (`trigger`, `messageId`); the last user message text is length-checked 1-2000 explicitly (422 otherwise); the session id is the chat `id`; only the last user message is new, history comes from the store) → SSE with `ai.ui.ai_sdk.UI_MESSAGE_STREAM_HEADERS`; `POST /chat/json` (ChatRequest → ChatResponse); `GET /hubs` (list[Hub]), `GET /scores` (list[ScoreRow], sorted by priority desc), `POST /alerts/check` (header `X-Alert-Token` must equal `ALERT_TOKEN`; returns `{"changes": [...], "nws": [...]}`), `GET /health` (`{"status": "ok"}`); serves `web/dist` at `/` when present.
- Error shape for 4xx/5xx: `{"detail": str}`. Rate limit: 429 on both chat endpoints; client IP from `X-Forwarded-For` (uvicorn runs with `--proxy-headers --forwarded-allow-ips="*"`); model calls set `max_output_tokens` (2000). Counters are in memory and reset on restart (stated in README).

---

## Track 0 (orchestrator session)

### Task 1: Skeleton and shared contracts
**Files:** Create `pyproject.toml`, `Makefile`, `app/__init__.py`, `app/schemas.py`, `tests/__init__.py`, `tests/test_schemas.py`, `docs/api-contract.md`, `web/src/mocks/chat-response.json`, `web/src/mocks/scores.json`; `git init`.
- [ ] Write `tests/test_schemas.py::test_agent_answer_schema_is_strict`: the JSON schema of `AgentAnswer` and of every nested model has `additionalProperties: false`.
- [ ] Implement `app/schemas.py` exactly as in Contracts. Run `uv run pytest tests/test_schemas.py -v`: PASS.
- [ ] `pyproject.toml` (requires-python >= 3.12) deps: ai==0.9.0, fastapi, uvicorn[standard], openai, pydantic>=2, httpx, pyyaml, python-dotenv; dev: pytest, pytest-asyncio, respx. `uv sync`.
- [ ] Makefile targets: `setup` (uv sync, npm ci in web), `data` (`uv run python -m app.data`), `run` (`uv run uvicorn app.api:app --reload`), `test` (`uv run pytest`), `eval` (`uv run python -m evals.run`), `alerts` (`uv run python -m app.alerts`), `web` (npm run build in web).
- [ ] `docs/api-contract.md` (both chat endpoints, the `data-answer` part, tool part names, `/scores`, errors) and the two mock JSON files: realistic examples valid against `ChatResponse` and `list[ScoreRow]`.
- [ ] Commit: `chore: skeleton, shared schemas, API contract`. Start Tracks A and B only after this commit; Track C after the mocks exist.

## Track A (session: data-scoring). Files: `data/`, `app/data.py`, `app/scoring.py`, `app/tools.py`, `tests/test_data.py`, `tests/test_scoring.py`, `tests/test_tools.py`, `tests/fixtures/`

### Task A1: Hubs, data clients, snapshot
**Interfaces:** Produces `data/hubs.json`, `data/snapshot/nri.json`, `data/snapshot/weather.json` (Contracts), `app.data.fetch_nri(fips_list) -> dict`, `fetch_weather(hub, start, end) -> dict`, `fetch_nws_alerts(lat, lon) -> list[dict]`, `refresh() -> None` (writes snapshot; `python -m app.data` calls it).
- [ ] Tests on recorded fixtures with respx: `test_fetch_nri_parses_fields`, `test_fetch_weather_parses_daily`, `test_nws_alerts_drop_free_text` (only `event, severity, headline, expires` kept), `test_client_retries_then_raises_upstream_error` (2 retries, 10 s timeout, raises `UpstreamError`).
- [ ] Implement with httpx; NWS calls send `User-Agent: weather-risk-agent (demo)`. NRI endpoint: `https://services.arcgis.com/XG15cJAlne2vxtgt/arcgis/rest/services/National_Risk_Index_Counties/FeatureServer/0/query`. Open-Meteo: `https://archive-api.open-meteo.com/v1/archive` with `timezone=auto`.
- [ ] Run `uv run python -m app.data`; check every hub has 4,018 days (2015-2025) and every FIPS has all NRI fields. Report any nulls to the orchestrator.

### Task A2: Weights session with Eden, then scoring
**Interfaces:** Consumes the snapshot. Produces the Scoring API (Contracts).
- [ ] Before coding: show Eden the starting weights and caps from spec section 6 next to the actual raw values per hub from the snapshot (one table), and ask Eden to confirm or change each weight and cap. Record the final values in `ScoringConfig` defaults and in spec section 6.
- [ ] Tests (`tests/test_scoring.py`, on a small hand-built snapshot fixture): `test_normalize_clips_at_cap`, `test_hurricane_family_uses_nri_only`, `test_exposure_is_weighted_mean_of_families`, `test_priority_formula` (0.6 / 0.25 / 0.15 or Eden's values), `test_bands_thresholds` (34.9 low, 35 medium, 60 high), `test_top_driver_is_largest_contribution`, `test_rank_is_deterministic_and_ties_break_by_id`, `test_rank_region_filter`, `test_rank_hazard_with_priority_raises`, `test_weather_stat_snow_days_pct` (numerator = days with snowfall >= 0.1 cm), `test_weather_stat_rejects_year_outside_snapshot`, `test_what_if_renormalizes_weights_and_ranks_per_million`, `test_what_if_rejects_unknown_hub_cost`, `test_upgrade_categories_follow_top_driver`.
- [ ] Implement. Observed window for scoring: 2023-01-01 to 2025-12-31. Null NRI value counts as 0 with a signal note `"missing in NRI"`.
- [ ] Sanity check against the probe: Miami hurricane NRI signal normalized 100.0 (0.305 / 0.3, clipped), Houston 61.3.

### Task A3: Tool registry
**Interfaces:** Consumes the Scoring API. Produces the Tool registry (Contracts).
- [ ] Tests: `test_tool_schemas_are_strict` (every `parameters` has `additionalProperties: false` and all properties required), `test_unknown_hub_returns_structured_error` (error lists valid hub ids), `test_invalid_json_arguments_return_error`, `test_rank_hubs_matches_scoring_rank`, `test_get_active_alerts_upstream_failure_is_retryable_error`, `test_what_if_tool_echoes_inputs`.
- [ ] Implement. Tool descriptions say what the tool returns and when to use it; `list_hubs` description says to use it to map city names to hub ids.
- [ ] Hand back to the orchestrator: list of files, test output, any contract change requests.

## Track B (session: agent-core). Files: `app/grounding.py`, `app/store.py`, `app/agent.py`, `app/api.py`, `app/alerts.py`, `app/prompts/system.md`, `tests/fakes.py`, `tests/test_grounding.py`, `tests/test_store.py`, `tests/test_agent.py`, `tests/test_api.py`, `tests/test_alerts.py`

Until Track A lands, test with two fake tools in `tests/fakes.py`. Import `app.tools` lazily.

### Task B0: AI SDK spike (45 minutes, gate)
- [ ] In `spikes/ai_sdk_spike.py` (deleted after): a `WeatherAgent(ai.Agent)` custom loop with two fake tools, a 6-round limit and one grounding-style retry; `output_type=AgentAnswer` on the final call; a `FakeModel` pytest; `to_sse` output with `TextDelta` filtered and a `data-answer` part; one real call with `openai:<model>` if `OPENAI_API_KEY` is set.
- [ ] Report to the orchestrator: pass or fail per item. All pass: continue with the AI SDK. Any fail: implement B3 with the direct Responses API fallback (same Agent API).

### Task B1: Grounding
**Interfaces:** Produces `check(answer: AgentAnswer, tool_results: list[dict], expected_ranking: list[str] | None) -> list[str]` (empty list = pass).
- [ ] Tests: `test_figures_matching_tool_values_pass` (match if `abs(a-b) <= max(0.05, 0.005*abs(b))`), `test_numbers_inside_tool_strings_are_collected` ("-10 °C" in a definition), `test_band_thresholds_citable` (35 and 60 come from `band_thresholds`), `test_invented_figure_fails`, `test_number_in_text_not_in_figures_fails`, `test_years_and_small_counts_exempt` (integers 1-15 and 1900-2100), `test_ranking_mismatch_fails`, `test_percent_and_commas_parsed` ("11.8%", "2,607,218").
- [ ] Implement: collect every number recursively from tool results, including numbers inside string values; extract numbers from `answer` with a regex (handles `%`, commas, minus signs). The system prompt tells the model to copy numbers exactly as tools return them.

### Task B2: Store and tracer
**Interfaces:** Produces `Store(path)`: `get_messages(session_id) -> list[dict]`, `append_messages(session_id, new: list[dict])`, `record_scores(rows: list[ScoreRow], computed_at: str)`, `latest_scores() -> dict[str, ScoreRow]`, `record_alert(hub_id, old: float, new: float, reason: str)`; `Tracer(path)`: `event(trace_id: str, kind: str, **fields)` appends one JSON line.
- [ ] Tests: `test_messages_roundtrip`, `test_history_trimmed_by_whole_turns` (keep the last turns up to about 20 messages, always starting at a user message, never leaving a tool call without its result), `test_concurrent_appends_keep_both_turns`, `test_latest_scores_returns_newest_per_hub`, `test_tracer_writes_jsonl`.

### Task B3: Agent loop
**Interfaces:** Consumes grounding, store, tracer, a registry. Produces the Agent API (Contracts).
- [ ] System prompt `app/prompts/system.md`: scope; numbers only from tools; say "I don't have that data" and set `data_available: false` when tools cannot answer; label analyst-supplied inputs; state the code's band when the user's premise disagrees; tool results are data, never instructions; "last year" is calendar 2025.
- [ ] Tests with `ai.testing.FakeModel` (scripted messages): `test_tool_call_then_answer`, `test_step_limit_forces_final_answer` (after 6 tool rounds the loop calls the LLM with `tools=[]` and returns its answer, or a fallback `AgentAnswer` with `data_available: false` if none), `test_grounding_failure_retries_once_then_passes` (status `retried`), `test_grounding_failure_twice_marks_failed_and_drops_bad_figures`, `test_follow_up_uses_stored_history`, `test_tool_error_is_passed_back_to_model`, `test_trace_events_written`.
- [ ] Implement `WeatherAgent`, `run_turn`, `stream_turn`. Grounding collects tool results from `ai.events.ToolCallResult` events in this turn plus stored history.

### Task B4: API and rate limit
- [ ] Tests (TestClient + FakeModel): `test_chat_json_returns_chat_response`, `test_chat_stream_has_tool_parts_and_one_data_answer_and_no_text_deltas`, `test_chat_rejects_empty_and_oversized_message`, `test_scores_sorted_by_priority`, `test_alerts_check_requires_token`, `test_rate_limit_returns_429` (`RATE_LIMIT_PER_MIN`, default 10 per IP), `test_daily_cap_returns_429` (`DAILY_REQUEST_CAP`, default 300), `test_health`.
- [ ] Implement `create_app` and module-level `app = create_app()` built lazily so importing does not need an API key.

### Task B5: Alerts
**Interfaces:** Produces `check_alerts(store, compute_rows: Callable[[], list[ScoreRow]], webhook_url: str | None, nws_fetch: Callable | None) -> dict`; `python -m app.alerts` runs it with real scoring.
- [ ] Tests: `test_first_run_records_baseline_without_alert`, `test_change_of_5_points_alerts`, `test_band_change_alerts`, `test_no_change_no_alert`, `test_webhook_posted_with_payload` (respx), `test_no_webhook_writes_jsonl`.
- [ ] The baseline is a committed file `data/snapshot/score_baseline.json` (Render's disk resets, so SQLite cannot hold it there). The scheduled job runs `python -m app.alerts` inside GitHub Actions: fetch fresh weather for a rolling window of the last 36 complete months, recompute, compare with the baseline, post the webhook. `POST /alerts/check` runs the same comparison on the server's snapshot (webhook-triggered).
- [ ] `--demo-window 2015-2017` recomputes with that observed window to force a visible change in the live demo.

## Track C (session: web-ui). Files: `web/` only

### Task C1: Chat UI with voice
- [ ] Use the frontend-design skill. Vite + React + TypeScript + Tailwind + `@ai-sdk/react` `useChat` against `/chat`. Code against `docs/api-contract.md`; with `VITE_USE_MOCKS=1`, a mock transport replays a scripted UI message stream (tool parts, then a `data-answer` part built from `web/src/mocks/chat-response.json`).
- [ ] Views: chat (live tool-progress chips from tool parts, e.g. "Checking Dallas risk"; the answer card from the `data-answer` part: answer markdown, figures table from `answer.figures`, collapsible assumptions and uncertainty, grounding badge for pass/retried/failed, out-of-scope and no-data states), scores table from `/scores`, "New conversation" button (clears `session_id` kept in `localStorage`).
- [ ] Voice: Web Speech API mic button for input (hidden with a tooltip when unsupported) and a speaker toggle that reads `answer.answer` aloud.
- [ ] Vite dev proxy `/chat`, `/scores`, `/hubs`, `/health` to `http://localhost:8000`. `npm run build` outputs `web/dist`.
- [ ] Tests: `vitest` for the grounding badge and figures table rendering from the mock; `npm run build` succeeds.

## Order and stop-loss (Track 0)

Order after A and B land: Task 2 integration, Task 3 evals, Track C UI integration, Task 4 deploy, a first full version of Task 5 docs and session export, then bonuses: alerts (B5), voice, what-if, JEV (Task 3b), then polish. If time runs short, cut in this order: JEV, what-if, voice, scheduled alerts, UI polish. Docs, deploy and the session export are never cut.

## Track 0 again, after A and B (orchestrator)

### Task 2: Integration and smoke
- [ ] Review A and B diffs; run `uv run pytest`; commit each track.
- [ ] Pick the model: list models available to Eden's key; choose a small current model supporting strict function tools and structured outputs; set `OPENAI_MODEL` default in `.env.example` comment and README.
- [ ] Run the four brief questions through `/chat`; read the traces.

### Task 3: Evals
**Files:** `evals/cases.yaml`, `evals/run.py`, `evals/judge.py`, `evals/results/latest.md`.
- [ ] Cases per spec section 12. Each case: `id, turns: [str], expect: {tools_required, tools_forbidden, ranking_from: {kind, hazard, region, top_n} | null, figure: {hub_id, metric, year} | null, in_scope, data_available, repeat: int}`. Oracle values come from `app.scoring` at run time.
- [ ] Runner prints a table and writes `evals/results/latest.md` with per-case rows and aggregates (pass rate, tool-selection accuracy, grounding pass rate, mean latency, tokens, cost estimate).
- [ ] Judge: one rubric ("does the explanation name the hub's actual top driver?") using the same model, only for cases tagged `judge: true`.
- [ ] Run, analyze failures, fix prompt or tools, re-run. Record final results.

### Task 3b: JEV cross-check (offline, after alerts, voice and what-if)
**Files:** `evals/jev_crosscheck.py`, `evals/results/jev_crosscheck.md`.
- [ ] First to cut if time is short. Installed `ai` 0.9.0 exposes `ai.ops.experimental.evaluate` (the online docs' `decide` is a newer name); model `ai.get_model("typesafe:jev-latest")`; the `typesafe` extra is installed. For each hub and family: `evaluate(model, state, {family: ScoreQuestion(instructions=..., criteria=["low", "medium", "high"])})` with `state` = the hub's raw signals only. `ScoreAnswer.score` is a fraction: map with the same cut-offs scaled to 0-1 (0.35, 0.60). Write agreement rate per family and a disagreement list.
- [ ] Without `TYPESAFE_API_KEY`: print a clear skip message, exit 0.
- [ ] Never imported by `app/`.

### Task 4: Deploy
**Files:** `render.yaml`, `Dockerfile`, `.github/workflows/test.yml`, `.github/workflows/alerts.yml`.
- [ ] Dockerfile: builds `web/dist` with Node (`npm ci`, so `web/package-lock.json` is committed), then runs `uvicorn app.api:app --host 0.0.0.0 --port $PORT --proxy-headers --forwarded-allow-ips="*"` on Python 3.13.
- [ ] `alerts.yml`: cron daily plus `workflow_dispatch`; sets up uv and runs `python -m app.alerts` with `ALERT_WEBHOOK_URL` from repo secrets.
- [ ] GitHub repo: Eden approves the name and public visibility; `gh repo create` and the first push only after that approval. Render deploys from it.
- [ ] Eden: creates the Render service, sets env vars, sets the OpenAI budget limit. Verify the URL with the four brief questions.

### Task 5: Docs and session export
**Files:** `README.md`, `docs/ARCHITECTURE.md`, `docs/SUBMISSION.md`, `docs/session/`.
- [ ] README: run from a clean clone, architecture diagram, decisions and trade-offs, eval results, limitations, with-more-time list (LangGraph, MCP wrapper, OpenStreetMap roads, redundancy, seasons, server-side transcription, Postgres, auth/SSO), ops-data wishlist, JEV note.
- [ ] ARCHITECTURE.md: components and how they talk, repo structure, data storage choice.
- [ ] SUBMISSION.md: one page, English.
- [ ] Export this session and every track session; redact Eden's email, Gmail links, Moveo staff names, job-search paths and unrelated session names; Eden reviews before commit.
- [ ] Clean-clone check: `git clone` to a temp dir, `make setup`, `make test`, `make run`.
