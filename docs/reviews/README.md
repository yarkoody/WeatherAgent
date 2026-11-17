# Reviews

Each piece of work was reviewed by an independent AI reviewer that had not seen the build conversation, only the spec, the plan and the code. These are short summaries: what each review found and what was done. The full exchanges are in the session transcripts in [`../session/`](../session/).

## 1. Plan review (before any code)
**Scope:** the spec, the implementation plan and the shared contracts, read before parallel work started. Checked against the installed AI SDK source.
**Found (12):**
- **The tracks wouldn't have integrated:** contract gaps between the plan and `schemas.py`.
- **The streaming design would have crashed:** `to_sse` can't carry a custom answer part.
- **Tool schemas weren't strict:** `@ai.tool` generates non-strict ones.
- **The JEV call was wrong:** wrong function name and model id.
- **Follow-ups would have broken:** a history trim that could orphan tool calls.
- **Correct answers would have failed grounding:** thresholds missing from tool outputs.
- **Alerts would never fire on Render:** the disk resets, so the baseline would be lost.
- **Mandatory deliverables were cut first:** a stop-loss order that dropped them before the bonuses.
**Done:** all fixed in the plan and contracts before the tracks started.

## 2. Agent core (Track B)
**Scope:** grounding, store, agent loop, API, alerts.
**Found:**
- **Critical:** none.
- **Important:**
  - A spoofable rate limit (it trusted the left-most `X-Forwarded-For`).
  - Grounding skipped `assumptions` and `uncertainty`.
  - Figures matched by value only, against a large pool, so a number belonging to another hub could pass.
  - Valid rankings ("lowest 2", filtered subsets) failed grounding.
  - The error path broke the "exactly one data-answer" contract.
**Done:** all fixed test-first. The minor findings were fixed too.

## 3. Data, scoring and tools (Track A)
**Scope:** data clients, snapshot, scoring, tools. Four hubs were recomputed by hand from the snapshot, and all matched.
**Found:**
- **Important:**
  - A rolling observed window divided by calendar years, which would understate observed days by about 25%. The alert job would have fired false alerts.
  - Family shares were reported as fractions, so the model's "62%" would fail grounding.
- **Minor:**
  - Non-finite what-if weights were accepted.
  - 4xx responses were retried.
  - A partial refresh could leave mismatched snapshot files.
  - There was no regression test on the committed snapshot.
**Done:** all fixed test-first.

## 4. Chat UI (PR #2)
**Scope:** the React UI, plus an automatic review by Claude's GitHub action.
**Found:**
- **Critical:** when grounding failed, citation tooltips still said each figure was verified.
- **Important:**
  - Read-aloud spoke unverified answers.
  - HTTP errors were hidden behind a generic message.
  - A stopped stream left spinners.
  - There was no error boundary.
  - A widget computed band thresholds instead of using the tool's values.
  - Markdown images from model text loaded automatically, which is a data-exfiltration path.
**Done:** all fixed, with tests (40 UI tests at that point).

## 5. Live checks after deploy
- **The rate limit:** the per-IP limit never triggered on Render. The right-most `X-Forwarded-For` entry is a proxy address that changes between requests. Fixed by reading Cloudflare's `CF-Connecting-IP` (PR #4). Verified live: request 11 returns 429, and a spoofed header is rejected with 403.
- **Raw markdown tables:** a live end-to-end test showed markdown tables as raw text. Fixed with `remark-gfm`, and the prompt now keeps tables out of answer prose.

## 6. Scoring formula review
**Scope:** an independent review of the KPI, with online research covering catastrophe-modeling practice, FEMA NRI methodology, published downtime data, and the OECD/JRC handbook on composite indicators.
**Found:**
- **Coastal flood counted every event as a hub closure,** though the flood zone covers only 2.5-9.2% of the county.
- **The expected value hid tail risk:** Miami had a 95% chance of a hurricane-class event per decade, yet read "medium".
- **The additive priority ranked hubs with almost no hazard highly.**
- **Per-hazard bands were miscalibrated:** 56 of 60 were "low", matching the JEV cross-check.
- **A 3-year observed window** was used when 11 years were available.
**Done:** formula v2. Coastal flood is scaled by the flood-zone share, the observed window is 11 years, per-hazard bands are in days, a bad-year (1-in-20) lens sits next to the typical year, priority is multiplicative, and a sensitivity analysis was added.

## 7. External review (Codex) and live checks
**Found:**
- **Grounding tied a number to a hub, not to its metric.** "Miami's hurricane probability is 25.6%" passed, though 25.6 was Miami's priority.
- **The UI overstated the model** ("days a hub can expect", "where upgrades help most").
- **Alerts repeated every day** and lost their de-duplication state on a fresh runner.
- **Unit-mixing explanations:** "430.3 mm of the 365 days".
- **A dev proxy gap.**

**Done:**
- Metric-bound grounding: each figure cites its tool field. A test covers the 25.6 case, and the real-model eval run passed 30/30.
- Honest wording: "modeled lost days (estimate)" and "screening priority".
- Alerts once per change, with state kept between runs.
- Unit-aware explanations, the full dev proxy, and a feature freeze afterwards.

**Live checks after deploy found:**
- **Missing data files in the Docker image:** "New York" resolved locally but not on Render, and the JEV column returned 404. The image now copies all data files, with a regression test.
- **Stale lazy chunks:** after a rebuild, an open tab couldn't draw widgets. It now reloads once.
- **A false alert from a method change:** the first real Discord alert compared old-formula numbers with new ones. Alerts now compare only within one formula version.
