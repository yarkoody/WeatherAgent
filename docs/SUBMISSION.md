# Weather Risk Intelligence Agent: submission summary

**Repository:** https://github.com/yarkoody/WeatherAgent · **Live demo:** https://weather-risk-agent-e60g.onrender.com (free tier, so the first request may take about a minute to wake the server)

## What it does
An AI agent for a logistics company's analysts. It answers which US distribution hubs are most exposed to weather disruption and which to prioritize for resilience investment, including the brief's four example questions and follow-ups. It ranks, compares and explains hubs with a KPI computed in deterministic code from public data (FEMA National Risk Index, Open-Meteo history, Census metro population, live NWS alerts). Every number in an answer is checked against the tool results before it is shown.

## How it works
- **Agent:** a bounded tool-calling loop (at most 6 tool rounds) on the Vercel AI SDK for Python, with an OpenAI model. Nine tools take strict JSON-schema arguments, and the final answer is a strict JSON schema (Pydantic). Eight tools read the scoring data; the ninth searches the web for current news and never changes a score.
- **Grounding:** each number must cite the exact tool field it came from (tool, field, hub). Code checks it, and rankings must keep the code's order. A failure gets one retry, then an "unverified" label.
- **KPI:** expected disruption days per year: FEMA event frequency × assumed downtime per event, blended with 11 years of observed bad-weather days. Two lenses: the typical year, and a bad year (the average of the worst 1 year in 20), because averages hide hurricanes. Review priority weighs exposure by people served and the community's resilience gap. It is a screening measure, not an ROI.
- **Interface:** a React chat with live tool progress, charts drawn only from tool outputs, suggested follow-ups and chat history. Also a hub map, "See the math" per hub, what-if sliders, CSV and PDF export, and voice: dictation, read-aloud, and a live mode that speaks only verified answers. FastAPI serves it, on Render with Docker, with per-IP rate limits and a daily cap.
- **Bonus alert:** a daily GitHub Actions job and a webhook endpoint re-score the hubs and post score changes to Discord, once per change. A real alert reached Discord, and a user can subscribe their own Discord channel in the app.

## Evidence that it works
- **Evals:** 47 cases against the real model, with expected values computed by the scoring code: the brief's four questions word for word, paraphrases, follow-ups, determinism, a false premise, missing data, prompt injection, recommendations, what-if and web search. Final run: 46/47. The one miss passed 3/3 when re-run alone (a retry left an optional field empty). Tool selection 46/46, grounding passed first try in 53/54 turns and after one retry in the other, 10.7 s per turn on average, about $2.11 for the run.
- **Reviews and live checks:** every part was reviewed independently before merge (`docs/reviews/`), and `docs/ASSIGNMENT_COVERAGE.md` maps each line of the brief to where it is met and how it was checked on the live site.
- **Second opinion (development only):** an offline cross-check against TypeSafe's JEV decision model exposed miscalibrated hazard bands in v1; agreement rose from 40% to 65% in v2.

## Key decisions
- **A bounded agent, not a router workflow:** analysts ask open, combined questions. Numbers stay in code.
- **FEMA frequency, not FEMA's risk score,** which saturates for every big metro.
- **Downtime days, not building-loss ratios:** snow closes hubs without damaging buildings.
- **Fixed thresholds in days,** so adding a hub never changes another hub's score.
- **Answers are never streamed,** so an unverified number can't flash on screen.
- **A snapshot in git plus SQLite,** for reproducible scores and a reliable live demo.

## Assumptions and limits
- **Hubs:** the 15 hub locations are my assumption, since the brief names none. Cities resolve to hubs through official OMB metro areas, so New York maps to Newark.
- **Downtime:** days per event are stated assumptions, checked against published figures and a sensitivity analysis.
- **Data:** FEMA data is county-level and modeled, and metro population is a proxy for the people a hub serves.
- **Out of scope:** company cost or volume data, forecasting, authentication. Extreme heat and wildfire are not modeled, and the agent says so.

Run instructions and decisions are in `README.md`, the design is in `docs/ARCHITECTURE.md`, prompts to try are in `docs/USER_GUIDE.md`, and every formula is in `docs/METHODOLOGY.md`. The complete AI session transcripts, including the plan, are in `docs/session/`.
