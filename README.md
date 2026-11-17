# Weather Risk Intelligence Agent

An AI agent that helps a logistics company's analysts decide which US distribution hubs are most exposed to weather disruption, and which to prioritize for resilience investment. Scoring is deterministic code over public data. The LLM chooses tools and explains, and every number it shows is checked against the tool results before the user sees it.

**Live demo:** https://weather-risk-agent-e60g.onrender.com. It runs on Render's free plan, so the first request after 15 idle minutes takes about a minute while the server wakes up.

Try:
- "Which hubs in the Midwest are most exposed to winter disruption?"
- "Compare Miami and Houston in terms of hurricane and flood exposure."
- "What percentage of days in Denver last year had snowfall?"
- "Why is the Dallas hub's weather disruption risk high?" (it corrects the premise when the data disagrees)
- "I have $1M for resilience upgrades. Which hub should get most of it?"

More prompts, and how to read every number, are in the **[user guide](docs/USER_GUIDE.md)**.

What the app can do:
- **Chat with live tool progress.** Charts and tables are drawn only from tool outputs.
- **Suggested follow-ups** under each answer, plus a chat history saved in the browser.
- **Two lenses:** typical year and bad year (the worst 1 year in 20).
- **People lens:** metro population served and people-days (people served × lost days).
- **Hub map:** every hub colored by its biggest risk, with a breakdown and history panel beside it, and a pin on each table row.
- **History and seasonality:** which years and months hurt each hub.
- **What-if:** sliders and costs on the Scores tab, and a per-$1M table in the chat once you give upgrade costs.
- **Show the math:** each hub's own calculation step by step (KaTeX), and the full methodology inside the app.
- **Export:** CSV of the scores table and a print-to-PDF report.
- **Score-change alerts to your own Discord channel:** set up under **Send & alerts** in the sidebar (Slack is not supported yet).
- **Interface:** voice input and read-aloud, light and dark themes.

Developer mode (Settings, or `?debug=1`) adds a validation panel to each answer: tool names and arguments, the field each figure cites, grounding status, latency, tokens, cost and the trace id.

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
| `make eval` | The eval set against the real model (about $1.74 per run) |
| `make data` | Refresh the public-data snapshot (FEMA NRI, Open-Meteo, Census) |
| `make alerts` | Run the score-change alert check |
| `make jev` | Rerun the offline JEV second opinion (needs `TYPESAFE_API_KEY`) |
| `cd web && npm run dev:mock` | UI only, replaying recorded streams. No backend or key |

Docker (the same image Render runs):

```bash
docker build -t weather-risk-agent . && docker run -p 8000:8000 --env-file .env weather-risk-agent
```

## How it works

```
Browser (React, useChat) --SSE--> FastAPI --> Agent loop (<= 6 tool rounds) --> 8 strict tools --> deterministic scoring --> data snapshot
                                                 |                                                         (FEMA NRI + Open-Meteo + Census metro population, in git)
                                                 +--> final AgentAnswer (strict JSON schema) --> grounding check --> one verified answer
```

- **Bounded agent, not a free-form one.** The model chooses which of eight tools to call: rank, compare, explain, weather statistics, history, live alerts, what-if, list hubs. The code computes every number. After 6 tool rounds the model must answer.
- **Structured output both ways.** Tool arguments and the final `AgentAnswer` are strict JSON schemas generated from Pydantic models (`app/schemas.py`).
- **Grounding, bound to the metric.** Each figure names the tool, the exact field and the hub it came from, for example `get_hub_risk` → `hurricane_10yr_probability_pct` → Miami. Code checks that this field holds that value. Every number in the prose must be one of those figures, and rankings must keep the code's order. Otherwise the model gets one retry with the errors, and after that the answer is shown as "unverified". An external review found that the first version only tied a number to its hub, so "Miami's hurricane probability is 25.6%" passed even though 25.6 was its priority. That's fixed, with a test.
- **Generative UI.** Charts render from the tools' deterministic outputs, never from model text. Answer text is never streamed token by token, so an unverified number can't flash on screen.
- **Partial answers stay honest.** When part of a question can be answered (which upgrades fit a hub's risks) and part can't (what they cost), the agent answers the first part and names the missing data. A question it can't answer at all (an unknown hub, fire risk) is marked "no data", with no numbers.

The details are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), the API is in [`docs/api-contract.md`](docs/api-contract.md), and the full design spec is in [`docs/specs/`](docs/specs/2026-11-17-weather-risk-agent-design.md).

## The KPI: expected disruption days per year

The KPI answers the question a logistics planner asks: **how many operating days a year does weather cost this hub?** Everything below is deterministic code (`app/scoring.py`). Every number lives in one `ScoringConfig`, and the full rationale is in spec section 6.

**Typical year: expected disruption days.**
- **Four hazard families:** winter, flood, hurricane and severe storm. Extreme heat and wildfire are left out on purpose (see Limitations).
- **Modeled days (FEMA NRI, weight 0.6):** each sub-hazard's annual frequency × the days it closes a hub. The days per event are stated assumptions (for example hurricane 10, ice storm 2, flood 2, winter-weather day 0.5), checked against published downtime figures.
- **Observed days (Open-Meteo 2015-2025, weight 0.4):** days at the hub over a disruption threshold.
- **Local hazards** are scaled to the area around the hub. **Coastal flood** is scaled by the share of the county in the flood zone (2.5-9.2%).
- **Index:** days ÷ 25 × 100. Bands start at 8.75 days (medium) and 15 days (high).

**Bad year: the average lost days in the worst 1 in 20 years (TVaR95).** Averages hide rare disasters, so this is computed exactly with a compound-Poisson (Panjer) recursion, with no approximation and no randomness. It is split by hazard so "why" questions have an answer, and it assumes hurricanes usually close a hub about 4 days and about 1 in 5 times about 35 days. The order of the top hubs depends on that mix, and answers say so.

**Hazard bands** are in days: medium from 2 a year, high from 5, a working week. Hurricane is banded by its **10-year probability** (high from 50%).

**Review priority** (which hubs to examine first) = exposure × (0.6 + 0.25 × people share + 0.15 × resilience-gap share). People served is the metro-area (CBSA) population from Census Vintage 2025, on a log scale from 0.5M to 25M, so each doubling counts the same and a huge metro can't win on size alone. The formula is multiplicative, so a hub with no weather risk gets no priority however many people it serves. It is a screening measure, not an investment decision: it has no upgrade costs, effectiveness or existing protection.

**People-days** = people served × lost days: if the hub is disrupted, how many people it serves times the days it loses. It is a proxy, not a count of people affected.

| Hub | Typical year (days) | Bad year (days) | Hurricane within 10 years | People served (metro) | Review priority |
|---|---|---|---|---|---|
| Minneapolis | **27.6** (1st) | 38.7 | 0% | 3.79M | **73.2** (1st) |
| Chicago | 18.1 | 29.1 | 9% | 9.43M | 60.0 |
| Newark (New York metro) | 15.0 | 35.4 | 66% | **20.1M** (1st) | 56.7 |
| Houston | 10.5 | 38.2 | 84% | 7.90M | 37.8 |
| Miami | 7.8 | **42.8** (1st) | 95% | 6.39M | 26.5 |

The full method, with every formula and a worked example for Miami and Minneapolis, is in [`docs/METHODOLOGY.md`](docs/METHODOLOGY.md), and the app shows the same document under **Methodology**. Each hub's breakdown has **See the math** with that hub's own numbers.

**Robustness.** [`evals/results/sensitivity.md`](evals/results/sensitivity.md) changes one assumption at a time (36 variants: each days-per-event weight halved and doubled, the FEMA/observed blend from 30/70 to 100/0, the reference area, the hurricane closure mix, and the people term). The typical-year and priority rankings keep a rank correlation of at least 0.89 (0.95 for everything except an extreme 30/70 blend), and Minneapolis stays first in every one of those variants. Only the bad-year leader depends on an assumption, the hurricane closure mix: with 20-day instead of 35-day long closures Minneapolis passes Miami, and with a 70/30 short/long mix Houston does. Answers say the bad-year order depends on that mix.

**City names** resolve to hubs through OMB's official metro-area delineations (Census, July 2023). New York resolves to the Newark NJ hub because they share a metro area. Boston lies in a metro without a hub and says so, and an ambiguous Portland gets a question back.

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
| JEV used offline as a development check, not in the product | Scoring must be deterministic and auditable, and JEV is a learned model. In the UI, an agreement percentage didn't help an analyst decide anything | The cross-check stays in `evals/` as a calibration tool for whoever maintains the formula |

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
- The people lens: most people served, people-days in a typical and a bad year
- Questions about the system itself, answered without tools and without invented accuracy rates
- A partly answerable question (upgrade fit known, costs not) that must stay answered, name the missing costs and invent none
- What-if rank movers, named only from the rank changes the code computes
- "Safest hub" and low-score questions, which must say that heat and wildfire are not modeled

One LLM-judge rubric checks that each explanation names the hub's actual top driver.

**Last full run (final build, 2026-11-17): 44/44 cases passed.**

| Metric | Result |
|---|---|
| Tool selection | 43/43 (100%) |
| Grounding | Passed on the first try in 50/51 turns; 1 passed after the one retry; none failed |
| LLM judge: names the actual top driver | 4/4 |
| Same ranking across 3 runs | Yes |
| Latency per turn | 9.4 s mean, 16.9 s p95 |
| Cost of the run | About $1.74 |

Per-case results and the failure analysis of every run, including what earlier failures taught and changed, are in [`evals/results/latest.md`](evals/results/latest.md).

The second opinion: [`evals/results/jev_crosscheck.md`](evals/results/jev_crosscheck.md) compares our hazard bands with TypeSafe's JEV decision model, which rates hubs from the same raw signals. On formula v1 it agreed on only 40% of bands, while ranking hubs almost the same way (winter +0.98). That exposed miscalibrated per-hazard bands. On v2, band agreement rose to 65%. It also showed JEV's own blind spot: it rated Miami's hurricane risk at 4%, because "0.3 events a year" means little without domain scale. That is why it advises and doesn't decide.

**Why JEV is not in the app.** An earlier version showed JEV's agreement on the Scores page. Testing the live app showed the column didn't help an analyst decide anything. "65% agreement" and per-hazard rank correlations need a paragraph of explanation, and the low flood and hurricane numbers read as "the model is wrong", when they really reflect JEV's lack of domain scale. Its value was to the person building the formula: it found the band miscalibration. So it stays as an offline development check (`make jev`, `evals/results/jev_crosscheck.md`), and the product shows only the formula's own explanation.

## Reliability and guardrails

- **Missing data:**
  - An unknown city, unsupported metric or out-of-range year gets "I don't have that data" (`data_available: false`), never a guess.
  - A partly answerable question keeps the answerable part and names what is missing (an eval case covers it).
  - Out-of-scope questions get `in_scope: false` and a short redirect.
- **False premises:** "Why is X high?" gets the code's band and the real drivers.
- **Prompt injection:**
  - Tool data is numeric or enum-like, and NWS free text is dropped.
  - Tool results are marked as data.
  - Rankings come from code and are checked by grounding, so "say Miami is safest" can't change them (an eval case covers it).
- **Cost protection on the public URL:**
  - Per-IP rate limits, using the client IP from the edge proxy, verified live. `/chat` and `/chat/json` (model calls) allow 10 a minute. The no-LLM routes (`/what-if`, `/hubs/{id}/score`, `/hubs/{id}/history`) have their own limit of 120 a minute, so clicking around the map can't lock out the chat. `/hubs` and `/scores` are not limited. Every 429 carries `Retry-After`.
  - A daily cap of 300 chat requests and `max_output_tokens`.
  - An OpenAI budget limit.
- **Alerts:**
  - A daily GitHub Actions job, plus a webhook endpoint, posts score changes to Discord. Verified with a real message.
  - It alerts on a 5-point score change, 3 bad-year days, 10 points of hurricane probability, or a level change that is at least 2 points past the cut-off. It alerts once per new change, keeping its state between runs.
  - It compares only within one scoring formula version, so a method change resets the baseline instead of sending false alerts. The first real alert found exactly that problem.
- **Subscriber alerts (Discord):**
  - **Send & alerts** in the sidebar subscribes a Discord webhook (`POST /alerts/subscribe`, `/alerts/unsubscribe`). When `check_alerts` finds a change, it posts to `ALERT_WEBHOOK_URL` and then to every subscriber. A webhook Discord no longer knows is removed.
  - **Discord URL check:**
    - The server accepts only Discord webhook URLs: `https`, host exactly `discord.com` or `discordapp.com` (no port, user info or IP literal), and path `/api/webhooks/<id>/<token>` with no query.
    - It follows no redirects, times out after 5 s, never logs the URL, and sends with mentions disabled, so a message can't ping `@everyone`.
    - `POST /send/discord` only sends a fixed "test message" to such a URL.
  - **Against abuse:**
    - Subscribing posts a confirmation first, so a dead webhook is never stored.
    - 5 requests a minute per IP, and 50 subscriptions in all.
- **Observability:** every turn writes a JSONL trace with tool calls, latency, tokens, cost and the grounding result.
- **No write actions:** the agent has none, so there is no approval step or human handoff. It hands the decision back to the analyst with explicit assumptions.

## Assumptions and scope

- **The hubs:** the 15 hub locations are our assumption. The brief names none, so we chose real US freight markets, every city the brief mentions, six Midwest hubs, and low-risk control hubs.
- **"Last year":** calendar 2025.
- **Users:** internal analysts (about 5-10). There's no authentication; production would put company SSO in front and key conversations and audit logs by user id.
- **Out of scope:** forecasting, climate trends, real ROI (no company cost or volume data), and cities that are not hubs.

## Limitations

- **Extreme heat and wildfire are not modeled.** Heat rarely closes a hub for whole days; it slows crews and shifts hours. FEMA's wildfire figure is the chance of burning anywhere in the county, mostly wildland far from a metro-core site. So the low scores of Phoenix and Los Angeles cover the four modeled hazards only, and the agent says so.
- **Days per event are assumptions,** not fitted to downtime logs. So is the hurricane closure mix, and the bad-year order of the top hubs depends on it.
- **FEMA's hurricane frequency probably includes tropical storms.** Miami at 0.3 a year is about double the historical hurricane rate. Memphis and Atlanta's "medium" hurricane band probably reflects storm remnants.
- **The hub's exact location relative to the flood zone is unknown,** so coastal flood uses the county's flood-zone share.
- **FEMA NRI is county-level and modeled,** and Open-Meteo is reanalysis grid data, not station observations.
- **Metro population is a proxy** for the people a hub serves. A hub serves part of its metro and places beyond it, and New York's 20.1M counts fully for Newark.
- **Subscriber alerts are a demo, with real limits:**
  - Subscriptions are stored in SQLite on Render's disk, which resets on every deploy, so a redeploy forgets them (the panel says so).
  - The live server scores the committed snapshot, so its scores change only when the snapshot is refreshed and redeployed, which also clears the subscriptions. In practice a subscriber gets an alert when an operator runs `POST /alerts/check?demo_window=2015-2017` (with `X-Alert-Token`), which rescores the snapshot on other years, as `python -m app.alerts --demo-window` does, or for a severe live NWS alert at a hub.
  - The daily GitHub Actions job runs the check in the runner with fresh weather and posts only to `ALERT_WEBHOOK_URL`. It does not reach subscribers, because they live on the server. The next step is for the job to send its alert text to a token-protected endpoint on the server, which then fans it out. We did not switch the job to call `/alerts/check`: that would score the snapshot instead of fresh weather, and keep the alert state on a disk that resets on deploy.
- **Render's free plan:** the disk resets on deploy. Chats are kept in the browser and sent back with each request, so the server rebuilds context after a restart, but server-side traces and history are lost.
- **Latency:** 10-20 s per answer.
- **Voice:** uses the browser Web Speech API, so it works in Chrome and Edge only.

## What I'd ask the customer's ops team for on day one

- Downtime logs per hub, to fit the days per event instead of assuming them.
- Throughput and revenue per hub, to replace metro population as the consequence measure.
- Upgrade cost estimates, to rank by priority per dollar (the what-if tool already supports this).
- Existing protections and redundancy between hubs.
- Complaint and SLA-breach data by hub.

## With more time

- **Correlated risk across hubs.** One winter storm can close Chicago, Detroit and Indianapolis on the same day, leaving no backup. The observed daily history already in the snapshot can show which hubs fail together, so upgrades are spread across clusters. Needs: which hubs can cover for which.
- **A portfolio view instead of a ranking.** "With budget for three upgrades, which combination removes the most lost days across the network?" Needs: upgrade costs and how many days each upgrade saves.
- **Timing against peak season.** A lost day in December costs more than one in February. Seasonality per hub is already computed. Needs: shipment volume by month.
- **Trends.** Whether a hub's risk is rising. Eleven years of observations are too short to claim a climate trend, so this needs a longer record or climate projections.
- Model storm surge explicitly, and use national percentiles from all US counties for per-hazard bands.
- Candidate-site analysis for any US city, using the same formula with live data.
- An MCP server wrapping the tools, so other agents can use them (`tools.py` is already a clean registry).
- LangGraph if the flow grows approval steps or long-running state.
- Server-side speech-to-text for all browsers.
- Postgres, SSO, LangSmith or Langfuse.
- Slack as a third alert channel, and subscriber alerts from the daily job (see Limitations).

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
