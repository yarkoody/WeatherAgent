# Weather Risk Intelligence Agent: submission summary

**Repository:** https://github.com/yarkoody/WeatherAgent · **Live demo:** https://weather-risk-agent-e60g.onrender.com (free tier, so the first request may take about a minute to wake the server)

## What it does
An AI agent for a logistics company's analysts. It answers questions about which US distribution hubs are most exposed to weather disruption, and which should be prioritized for resilience investment, including the brief's four example questions and follow-ups. It ranks, compares and explains hubs using a KPI computed in deterministic code from public data (FEMA National Risk Index, Open-Meteo history, Census metro population, live NWS alerts). Every number in an answer is verified against tool results before it is shown.

## How it works
- **Agent:** a bounded tool-calling loop on the Vercel AI SDK for Python (at most 6 tool rounds), using an OpenAI model. Eight tools have strict schemas, and the final answer is a strict JSON schema (Pydantic) in both directions.
- **Grounding:** each number in the answer must cite the exact tool field it came from (tool, field, hub), code checks it, and rankings must keep the code's order. Failures get one retry, then an "unverified" label.
- **KPI:** expected disruption days per year, built from FEMA event frequency × assumed downtime per event and blended with 11 years of observed bad-weather days. Two lenses are shown: the typical year, and a bad year (the exact average of the worst 1 in 20 years, TVaR), because averages hide hurricanes. Review priority (which hubs to examine first) multiplies exposure by the people served (metro population, log scale) and the community's resilience gap; it is a screening measure, not an ROI.
- **Interface:** a React chat (AI SDK UI `useChat`) with live tool progress, charts drawn only from tool outputs, suggested follow-ups and chat history. A US map with a per-hub breakdown and history, "See the math" for each hub, the methodology inside the app, what-if sliders and a per-$1M table, CSV and PDF export, voice input and read-aloud, and a developer validation panel. It is served by FastAPI, deployed on Render with Docker, and has a per-IP rate limit and a daily cap.
- **Bonus alert:** a daily GitHub Actions job (and a webhook endpoint) re-scores hubs and posts score changes to a Discord webhook. It alerts once per change and resets its baseline when the scoring method changes. Verified with a real message.

## Evidence that it works
- **Evals:** 41 cases against the real model with an oracle: the brief's four questions word for word, paraphrases, follow-ups, determinism, a false premise, missing and partly missing data, city resolution, history, the people lens, prompt injection, and recommendations. Final run: 41/41 passed. Tool selection was 100% correct, grounding passed on the first try in 48/48 turns, turns averaged 9.5 s, and the run cost about $1.60.
- **Independent reviews and live checks:** every part was reviewed before merge, and the live app was tested by hand with the prompts in `docs/USER_GUIDE.md`. Each review's findings and fixes are summarized in `docs/reviews/`.
- **Second opinion (development only):** an offline cross-check against TypeSafe's JEV decision model. It exposed miscalibrated hazard bands in v1, and band agreement rose from 40% to 65% in v2. It was removed from the UI because an agreement score didn't help an analyst decide anything.

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
- **Data quality:** FEMA data is county-level and modeled, and metro population is a proxy for the people a hub serves.
- **Out of scope:** no company cost or volume data, forecasting or authentication.

Run instructions, architecture, decisions and the full analysis are in `README.md` and `docs/ARCHITECTURE.md`; prompts to try are in `docs/USER_GUIDE.md`, and every formula is in `docs/METHODOLOGY.md`. The complete AI session transcripts are in `docs/session/`.
