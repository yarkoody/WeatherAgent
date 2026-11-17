# Weather Risk Intelligence Agent: submission summary

**Repository:** https://github.com/yarkoody/WeatherAgent · **Live demo:** https://weather-risk-agent-e60g.onrender.com (free tier, so the first request may take about a minute to wake the server)

## What it does
An AI agent for a logistics company's analysts. It answers questions about which US distribution hubs are most exposed to weather disruption, and which should be prioritized for resilience investment, including the brief's four example questions and follow-ups. It ranks, compares and explains hubs using a KPI computed in deterministic code from public data (FEMA National Risk Index, Open-Meteo history, live NWS alerts). Every number in an answer is verified against tool results before it is shown.

## How it works
- **Agent:** a bounded tool-calling loop on the Vercel AI SDK for Python (at most 6 tool rounds), using an OpenAI model. Seven tools have strict schemas, and the final answer is a strict JSON schema (Pydantic) in both directions.
- **Grounding:** code checks that every number in the answer matches a tool result for the same hub, and that rankings keep the code's order. Failures get one retry, then an "unverified" label.
- **KPI:** expected disruption days per year, built from FEMA event frequency × assumed downtime per event and blended with 11 years of observed bad-weather days. Two lenses are shown: the typical year, and a bad year (the exact average of the worst 1 in 20 years, TVaR), because averages hide hurricanes. Investment priority multiplies exposure by the people served and the community's resilience gap.
- **Interface:** a React chat (AI SDK UI `useChat`) with live tool progress, charts drawn only from tool outputs, plain-language "how is this calculated" tips, suggested follow-ups, voice input and read-aloud. It is served by FastAPI, deployed on Render with Docker, and has a per-IP rate limit and a daily cap.
- **Bonus alert:** a daily GitHub Actions job (and a webhook endpoint) re-scores hubs and posts score changes to a Discord webhook.

## Evidence that it works
- **Evals:** 29 cases against the real model with an oracle: the brief's questions, follow-ups, determinism, a false premise, missing data, city resolution, prompt injection, and recommendations. Last run: 28/29 as run, and 29/29 after fixing one eval check that rejected a correct answer. Tool selection was 100% correct, grounding passed on the first try in 35/35 turns, turns averaged about 9 s, and the run cost about $0.82.
- **Independent reviews:** every part was reviewed before merge. Each review's findings and fixes are summarized in `docs/reviews/`.
- **Second opinion:** an offline cross-check against TypeSafe's JEV decision model. It never changes scores. It exposed miscalibrated hazard bands in v1, and band agreement rose from 40% to 65% in v2.

## Key decisions
- **A bounded agent instead of a router workflow**, because analysts ask open, combined questions. Numbers stay in code.
- **FEMA frequency rather than FEMA's risk score**, because the risk score saturates for every big metro.
- **Downtime days rather than building-loss ratios**, because snow closes hubs without damaging buildings.
- **Fixed thresholds in days**, so adding a hub never changes another hub's score.
- **Answers are never streamed**, so unverified numbers can't flash on screen.
- **A snapshot in git and SQLite** for reproducibility and a reliable live demo.

## Assumptions and limits
- **Hubs:** the 15 hub locations are my assumption, since the brief names none. Cities resolve to hubs via official OMB metro areas, so New York maps to Newark.
- **Downtime:** days per event are stated assumptions, checked against published downtime figures and a sensitivity analysis.
- **Data quality:** FEMA data is county-level and modeled, and population is a proxy for demand.
- **Out of scope:** no company cost or volume data, forecasting or authentication.

Run instructions, architecture, decisions and the full analysis are in `README.md` and `docs/ARCHITECTURE.md`. The complete AI session transcripts are in `docs/session/`.
