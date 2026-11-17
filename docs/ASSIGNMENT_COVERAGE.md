# Assignment coverage

Every line of the brief, where it is met, and how it was checked. The live checks ran against https://weather-risk-agent-e60g.onrender.com on 2026-11-18, on the build deployed from `main`. The eval numbers are from [`evals/results/latest.md`](../evals/results/latest.md).

## The four example questions

Each was asked word for word on the live site (`POST /chat/json`). All four came back with grounding `pass`, and each is also an eval case that passed.

| Question | Live answer | Tool | Eval case |
|---|---|---|---|
| Which hubs in the Midwest are most exposed to winter disruption? | Minneapolis 92.1, Chicago 43.6, Detroit 39.4, Columbus 34.5, Indianapolis 31.7, Kansas City 30.7 (winter exposure score) | `rank_hubs` | `brief_midwest_winter` |
| Compare Miami and Houston in terms of hurricane and flood exposure. | Hurricane: Miami 3.0 days a year, Houston 1.8; 10-year probability 95.3% and 84.1%. Flood: Houston 5.9 days a year, Miami 3.1 | `compare_hubs` | `brief_miami_houston` |
| What percentage of days in Denver last year had snowfall? | 10.1% of days in 2025 | `weather_stat` | `brief_denver_snow` |
| Why is the Dallas hub's weather disruption risk high? | Corrects the premise: Dallas is medium (score 54.7, 13.7 days a year), then names the drivers: flood 6.9, winter 3.4, severe storm 3.2 days a year | `get_hub_risk` | `brief_dallas_why_high` |

## The agent should

| Line in the brief | Status | Where | How it was checked |
|---|---|---|---|
| Use public APIs to gather weather and hazard data | Met | `app/data.py`: FEMA National Risk Index, Open-Meteo history, Census metro population, saved as a snapshot (`data/snapshot/`, with `provenance.json`). `app/tools.py`: live NWS alerts | `make data` refreshes the snapshot. The live NWS call is the eval case `live_alerts_houston` |
| Rank or compare hubs based on your defined logic or KPI | Met | `app/scoring.py`: expected disruption days a year, the bad year (TVaR95) and review priority. Tools `rank_hubs` and `compare_hubs` | Live: `GET /scores` returns 15 hubs; the ranking and comparison questions above |
| Explain its reasoning clearly | Met | Each answer carries its figures (tool, field, hub), assumptions and data limits. The UI adds "See the math" per hub and the methodology document | Live: the Dallas answer above. An LLM judge checks that explanations name the hub's actual top driver: 4/4 |
| Support conversational follow-up questions | Met | Conversation history per session (`app/store.py`, and the browser sends it back) | Live: "Why is the first one ranked first?" after the Midwest ranking answered for Minneapolis (23.0 winter days a year, 83.5% of its total). Eval cases `followup_first_one`, `followup_and_chicago`, `invest_followup_costs`, `metro_boston_followup` |

## Requirements

| Line in the brief | Status | Where | How it was checked |
|---|---|---|---|
| Include some deterministic scoring or ranking logic (not only LLM output) | Met | `app/scoring.py`: pure functions, every constant in one `ScoringConfig`. The model never computes a number | Eval `determinism_priority`: the same ranking in 3 runs. `tests/test_scoring.py`. Live: `POST /what-if` re-ranks with no model call |
| Include a chat interface to talk with the agent | Met | `web/` (React, `useChat`), served by FastAPI | Live in the browser: asked a question, got a "Figures checked" answer and a chart, then clicked a suggested follow-up and got a comparison table |
| Voice is a bonus | Met | Dictation and read-aloud in the chat (browser Web Speech API). **Live** voice mode: realtime transcription in, the normal checked `/chat` turn, then the verified answer read aloud (`app/voice.py`, `POST /voice/session`, `GET /voice/speak`). Chrome and Edge | The controls are on the live site. Dictation was tested by hand with a real microphone. `tests/test_voice.py` and the UI test `liveVoice.test.tsx` cover live mode |
| Bonus: a scheduled or webhook-triggered alert when a hub's risk score changes | Met | Scheduled: `.github/workflows/alerts.yml` runs `python -m app.alerts` daily at 06:00 UTC. Webhook-triggered: `POST /alerts/check` (token-protected). Alerts go to a Discord webhook, and to any Discord webhook a user subscribes under **Send & alerts** | Tested with real Discord messages on a local run of the same build: a test message, a subscription confirmation, and a real alert sent through `POST /alerts/check`. `tests/test_alerts.py`, `tests/test_send.py`. Live: the Send & alerts panel opens, and `POST /alerts/subscribe` rejects a non-Discord URL with 422 |
| Expose the agent through an API that the chat interface uses | Met | `app/api.py`: `POST /chat` (the stream the UI uses) and `POST /chat/json` (the same turn as plain JSON). The API is described in [`api-contract.md`](api-contract.md) | Live: both routes answered; the UI's requests go to `/chat` |
| Enforce a structured output format (JSON schema) between the LLM and your code | Met | `app/schemas.py`: `AgentAnswer` and the tool argument models. `app/agent.py` sends them as strict JSON schemas, so the model can't return anything else. `app/grounding.py` then checks every number | Live: every answer above is an `AgentAnswer` with figures, assumptions, uncertainty, `data_available` and `in_scope`. `tests/test_schemas.py`, `tests/test_grounding.py` |
| Include a small evaluation set and a way to run it | Met | `evals/cases.yaml` (47 cases), `evals/run.py`, `evals/judge.py`. Run with `make eval` | Last full run: 46/47 passed, tool selection 46/46, grounding passed first try in 53/54 turns and after one retry in the other. The one miss (`people_bad_year`) passed 3/3 when re-run alone. Results in `evals/results/latest.md` |
| Clearly communicate assumptions, uncertainty and scoping | Met | In every answer: `assumptions` and `uncertainty` fields, shown as "Assumptions" and "Data limits". In the docs: README sections "Assumptions and scope" and "Limitations", and [`METHODOLOGY.md`](METHODOLOGY.md) | Live: "What is the fire risk in Phoenix?" answered that wildfire is not modeled, with no numbers (`data_available: false`). The Denver answer states that "last year" means 2025. Eval cases `unsupported_fire_risk`, `missing_boise`, `out_of_scope_stock`, `safest_hubs_scope` |

## Deliverables

| Line in the brief | Status | Where |
|---|---|---|
| Source code, with instructions to run it | Met | This repository. [`README.md`](../README.md), "Run it locally": `make setup`, `make web`, `make run`, or Docker |
| Able to run the agent live; a URL is preferred | Met | https://weather-risk-agent-e60g.onrender.com, deployed from `main` on Render. It also runs locally from a clean clone |
| Design document: system architecture, the components and how they talk to each other | Met | [`ARCHITECTURE.md`](ARCHITECTURE.md), "System architecture": a diagram, a component table and one chat turn step by step |
| Design document: repository structure | Met | [`ARCHITECTURE.md`](ARCHITECTURE.md), "Repository structure" |
| Design document: data storage choice | Met | [`ARCHITECTURE.md`](ARCHITECTURE.md), "Data storage choice" |
| The full session with the AI agent, including the plan | Met | Sent with the submission email as a zip: the orchestrating session and every side session that built the project, 13 transcripts with an index. They are not in this public repository, because they are personal working conversations. The plan is [`plans/2026-11-17-implementation-plan.md`](plans/2026-11-17-implementation-plan.md), and the spec is [`specs/2026-11-17-weather-risk-agent-design.md`](specs/2026-11-17-weather-risk-agent-design.md) |

## Known gaps

- **The scheduled alert job has not had its first run on GitHub Actions yet.** The workflow was added after 06:00 UTC on 2026-11-17, so its first scheduled run is 06:00 UTC on 2026-11-18. The same check has run by hand and through `POST /alerts/check`, and posted to Discord.
- **Subscriber alerts are a demo.** Subscriptions live on a disk that resets on deploy, and the daily job does not reach them yet. The README's Limitations section has the details.
- **Voice works in Chrome and Edge only,** because it uses the browser's speech API and WebRTC.
- **One eval case missed in the last full run** (46/47). `people_bad_year` got a correct answer on the retry, but the retry left the optional `ranking` field empty. It passed 3/3 when re-run alone. The fix (keep the ranking from the first attempt) is noted in `evals/results/latest.md`, not applied.
