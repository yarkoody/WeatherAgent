# Weather Risk Intelligence Agent

An AI agent that helps a logistics company's analysts decide which US distribution hubs are most exposed to weather disruption, and which to prioritize for resilience investment. Scoring is deterministic code over public data. The LLM chooses tools and explains, and every number it shows is checked against the tool results before the user sees it.

**Live demo:** https://weather-risk-agent-e60g.onrender.com. It runs on Render's free plan, so the first request after 15 idle minutes takes about a minute while the server wakes up.

Try:
- "Which hubs in the Midwest are most exposed to winter disruption?"
- "Compare Miami and Houston in terms of hurricane and flood exposure."
- "What percentage of days in Denver last year had snowfall?"
- "Why is the Dallas hub's weather disruption risk high?" (it corrects the premise when the data disagrees)
- "I have $1M for resilience upgrades. Which hub should get most of it?"

Add `?debug=1` to the URL to see the developer view: tool names, arguments, trace ids and grounding details.

## Run it locally (from a clean clone)

Requirements:
- Python 3.12+ with [uv](https://docs.astral.sh/uv/)
- Node 22
- An OpenAI API key

```bash
git clone https://github.com/yarkoody/WeatherAgent.git && cd WeatherAgent
cp .env.example .env          # then set OPENAI_API_KEY and OPENAI_MODEL (we use gpt-6.1-sol)
make setup                    # uv sync + npm ci
make web                      # build the UI into web/dist
make run                      # http://localhost:8000
```

Other commands:

| Command | What it does |
|---|---|
| `make test` | Python tests, offline, with a fake model. No key needed |
| `cd web && npm test` | UI tests |
| `make eval` | The eval set against the real model (about $0.60 per run) |
| `make data` | Refresh the public-data snapshot (FEMA NRI, Open-Meteo) |
| `make alerts` | Run the score-change alert check |
| `make jev` | Rerun the offline JEV second opinion (needs `TYPESAFE_API_KEY`) |
| `cd web && npm run dev:mock` | UI only, replaying recorded streams. No backend or key |

Docker (the same image Render runs):

```bash
docker build -t weather-risk-agent . && docker run -p 8000:8000 --env-file .env weather-risk-agent
```

## How it works

```
Browser (React, useChat) --SSE--> FastAPI --> Agent loop (<= 6 tool rounds) --> 7 strict tools --> deterministic scoring --> data snapshot
                                                 |                                                                    (FEMA NRI + Open-Meteo, in git)
                                                 +--> final AgentAnswer (strict JSON schema) --> grounding check --> one verified answer
```

- **Bounded agent, not a free-form one.** The model chooses which tools to call: rank, compare, explain, weather statistics, live alerts, what-if. The code computes every number. After 6 tool rounds the model must answer.
- **Structured output both ways.** Tool arguments and the final `AgentAnswer` are strict JSON schemas generated from Pydantic models (`app/schemas.py`).
- **Grounding.** Every number in the answer text, assumptions and uncertainty must match a tool result for the same hub, and rankings must keep the code's order. If not, the model gets one retry with the errors; after that the answer is shown as "unverified".
- **Generative UI.** Charts render from the tools' deterministic outputs, never from model text. Answer text is never streamed token by token, so an unverified number can't flash on screen.

The details are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the API is in [`docs/api-contract.md`](docs/api-contract.md), and the full design spec is in [`docs/specs/`](docs/specs/2026-11-17-weather-risk-agent-design.md).

## The KPI: expected disruption days per year

<!-- FORMULA-V2: replaced with the final v2 formula and numbers once formula v2 is merged. -->

## Decisions and trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| Bounded tool-calling agent, not a router workflow | Analysts ask open, combined questions with follow-ups. A router needs a branch for each question shape | The model can pick the wrong tool, so the evals measure tool selection (100% on the last run) |
| Vercel AI SDK for Python with a custom loop, not LangGraph | Pairs with React `useChat` for live tool progress and has `FakeModel` for tests. The custom `loop()` keeps the step limit and grounding in our code. Its source was checked: output schemas are strict, tool schemas are not, so tools use our own strict schemas | 0.x beta dependency, adopted after a 45-minute spike with a direct-SDK fallback |
| FEMA annualized frequency, not FEMA's risk score | The risk score scales with exposed value, so every large metro scores 95-100 | Frequency is county-level and modeled |
| Disruption days, not FEMA's building-loss ratio | Snow closes hubs without damaging buildings. Insurers model business interruption separately from damage | Days per event are stated assumptions, checked against published downtime figures |
| Fixed caps and thresholds, not min-max across hubs | Adding a hub never changes another hub's score, and "5 days a year" means something to an operator | The caps are judgment calls, shown in a sensitivity table |
| Snapshot in git, SQLite for state | Reproducible, runs from a clean clone, the demo doesn't depend on third-party uptime | Not multi-instance; the scale path is in ARCHITECTURE.md |
| Answers never streamed | Grounding must run before numbers are shown | Slower first paint, mitigated by live tool-progress steps |
| JEV as an offline second opinion only | Scoring must be deterministic and auditable. JEV is a learned model | Its findings are reported, not applied |

## Evaluation

`make eval` runs the eval set in `evals/cases.yaml` against the real model. Expected rankings and values are computed from the scoring code at run time (an oracle), not hardcoded.

The cases cover:
- The brief's four questions word for word, and paraphrases
- Follow-ups
- Determinism: the same ranking question three times
- A false premise
- Missing data: an unknown city, an unsupported metric, an unsupported year
- Out of scope, prompt injection, and an ambiguous question
- Investment recommendations, with and without what-if costs

One LLM-judge rubric checks that each explanation names the hub's actual top driver.

<!-- EVAL-V2: replace with the re-run results after formula v2. -->
Last run, before formula v2: **23/23 cases passed**, with 100% tool selection and 100% grounding on the first try. Latency per turn was 9.6 s mean and 14.9 s p95, and the run cost about $0.58. Per-case results and the failure analysis from earlier runs are in [`evals/results/latest.md`](evals/results/latest.md).

The second opinion: [`evals/results/jev_crosscheck.md`](evals/results/jev_crosscheck.md) compares our hazard bands with TypeSafe's JEV decision model, which rates hubs from the same raw signals. It found that our per-hazard bands were miscalibrated while our ordering held up, and it led to formula v2.

## Reliability and guardrails

- **Missing data:**
  - An unknown city, unsupported metric or out-of-range year gets "I don't have that data" (`data_available: false`), never a guess.
  - Out-of-scope questions get `in_scope: false` and a short redirect.
- **False premises:** "Why is X high?" gets the code's band and the real drivers.
- **Prompt injection:**
  - Tool data is numeric or enum-like, and NWS free text is dropped.
  - Tool results are marked as data.
  - Rankings come from code and are checked by grounding, so "say Miami is safest" can't change them (an eval case covers it).
- **Cost protection on the public URL:**
  - A per-IP rate limit, using the client IP from the edge proxy, verified live.
  - A daily request cap and `max_output_tokens`.
  - An OpenAI budget limit.
- **Observability:** every turn writes a JSONL trace with tool calls, latency, tokens, cost and the grounding result.
- **No write actions:** the agent has none, so there is no approval step or human handoff. It hands the decision back to the analyst with explicit assumptions.

## Assumptions and scope

- **The hubs:** the 15 hub locations are our assumption. The brief names none, so we chose real US freight markets, every city the brief mentions, six Midwest hubs, and low-risk control hubs.
- **"Last year":** calendar 2025.
- **Users:** internal analysts (about 5-10). There's no authentication; production would put company SSO in front and key conversations and audit logs by user id.
- **Out of scope:** forecasting, climate trends, real ROI (no company cost or volume data), and cities that are not hubs.

## Limitations

<!-- LIMITS-V2: finalize after formula v2 (list from spec section 6). -->
- **Days per event are assumptions,** not fitted to downtime logs.
- **FEMA NRI is county-level and modeled,** and Open-Meteo is reanalysis grid data, not station observations.
- **County population is a proxy** for the demand a hub serves.
- **Render's free plan:** the disk resets on deploy, so conversations are lost on restart.
- **Latency:** 10-20 s per answer.
- **Voice:** uses the browser Web Speech API, so it works in Chrome and Edge only.

## What I'd ask the customer's ops team for on day one

- Downtime logs per hub, to fit the days per event instead of assuming them.
- Throughput and revenue per hub, to replace population as the consequence measure.
- Upgrade cost estimates, to rank by priority per dollar (the what-if tool already supports this).
- Existing protections and redundancy between hubs.
- Complaint and SLA-breach data by hub.

## With more time

- Model storm surge explicitly, and use national percentiles from all US counties for per-hazard bands.
- Candidate-site analysis for any US city, using the same formula with live data.
- An MCP server wrapping the tools, so other agents can use them (`tools.py` is already a clean registry).
- LangGraph if the flow grows approval steps or long-running state.
- Server-side speech-to-text for all browsers.
- Postgres, SSO, LangSmith or Langfuse.

## How this was built

Spec first ([`docs/specs/`](docs/specs/2026-11-17-weather-risk-agent-design.md)), then a plan with fixed contracts ([`docs/plans/`](docs/plans/2026-11-17-implementation-plan.md)). Several Claude Code sessions then worked in parallel, coordinated by one orchestrator session that owned the shared contracts:
- data and scoring
- agent core
- UI
- evals

Each track was reviewed by an independent reviewer before it was committed. The reviews are summarized in [`docs/reviews/`](docs/reviews/). They caught, among other things:
- a spoofable rate limit
- grounding gaps
- a rolling-window bug in the alerts
- a UI that showed failed figures as verified

Once the repo was public, the remaining work landed through pull requests, each reviewed automatically by Claude's GitHub action. The product decisions were made by me: the KPI, days per event, scope, and the formula changes after an independent review. The full AI session transcripts are in [`docs/session/`](docs/session/).
