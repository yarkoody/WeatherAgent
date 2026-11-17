# Reviews

Each piece of work was reviewed by an independent AI reviewer that had not seen the build conversation, only the spec, the plan and the code. These are short summaries: what each review found and what was done. The full exchanges are in the session transcripts, which are sent with the submission email, not kept in this public repository.

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
- Honest wording: "modeled lost days (estimate)" and "screening priority" (later renamed "review priority").
- Alerts once per change, with state kept between runs.
- Unit-aware explanations, the full dev proxy, and a feature freeze afterwards.

**Live checks after deploy found:**
- **Missing data files in the Docker image:** "New York" resolved locally but not on Render, and the JEV column returned 404. The image now copies all data files, with a regression test.
- **Stale lazy chunks:** after a rebuild, an open tab couldn't draw widgets. It now reloads once.
- **A false alert from a method change:** the first real Discord alert compared old-formula numbers with new ones. Alerts now compare only within one formula version.

## 8. Data and scoring review of the people lens
**Scope:** an independent review of the metro-population data, the people term in review priority, and the people-days measure, before they were merged.
**Found:**
- **Population data one year old:** Census Vintage 2024 was used when Vintage 2025 was out.
- **No record of where each number came from:** no source period or vintage was stored with the snapshot.
- **A config change could still fire false alerts** if the scoring version string wasn't bumped.
- **Two definitions of people-days** in the prompt, and "priority" read as an investment decision.

**Done:**
- Vintage 2025 with a 25M log-scale cap that no hub reaches.
- `data/snapshot/provenance.json` names each source, period and fetch time.
- The alert formula version became `SCORING_VERSION` plus a hash of the config.
- One people-days definition, and the name "review priority, based on the typical year".
- The remaining limits are listed in the spec: band edges, independent events, mixed geographies, and the Los Angeles winter artifact.

## 9. Example chats and a manual run of the live app
**Scope:** real conversations with the deployed app, reviewed line by line, then every prompt in [`../USER_GUIDE.md`](../USER_GUIDE.md) run by hand in a browser on the live app.
**Found:**
- **A partial answer was marked "No data"** when it answered the upgrade fit and only the costs were missing.
- **The comparison table was hard to read:** a 5-hub verdict with an unlabeled list of numbers, and a duplicate bad-year line.
- **No chart for the what-if cost ranking:** it came back as text only, labeled "Re-ranked with your weights" although the user gave costs.
- **"See the math" sums that didn't add up** because each part was rounded on its own, for example "36.05 + 14.18 + 6.52 = 56.7".
- **The methodology tables ran 1,600 px wide.**
- **Newark's 20.1M people weren't named as the New York metro.**

**Done:**
- The no-data rule applies only when no part of a question can be answered. A new eval case checks that missing costs are named and none are invented.
- The verdict names the leader and runner-up by name.
- A per-$1M table in the chat, and a step label that says what was supplied.
- "≈" with a note wherever rounding applies, and a test on every hub.
- The methodology tables wrap.
- The prompt names the metro. The full eval run after these fixes passed 41/41, with grounding 48/48 on the first try.

## 10. Two friends' test passes
**Scope:** two people outside the project used the live app freely, without a script, and reported what looked wrong.
**Found, across the two passes:**
- **Clicking around the map locked out the chat:** the map's per-hub requests shared the chat's limit of 10 a minute.
- **A one-hazard chart and its answer disagreed on level:** bars were colored by the 0-100 score's level, while the text cited the hazard's own level in lost days.
- **The what-if answer named hubs as moving that hadn't moved.**
- **Phoenix and Los Angeles came out "safest"** with no word that heat and wildfire aren't in the model.
- **A failed question, resent, showed twice,** and a per-minute limit offered no retry.
- **"Ask next" repeated the comparison just answered.**
- **Winter and flood looked alike on the map.**
- **Chicago's 59.99 reads high,** and **Los Angeles has a winter risk** it doesn't have at sea level.

**The second tester also tried:**
- **An off-topic riddle in Hebrew and an emergency question** (someone with a knife).
- **And hit a "did not respond" error** in the middle of an answer.

**Done:**
- The no-LLM routes (`/what-if`, a hub's score and history) have their own limit of 120 a minute, and every 429 carries `Retry-After`.
- One-hazard charts color bars by that hazard's level from the tool (2 and 5 lost days a year, drawn as scores 8 and 20; hurricane by its 10-year chance), the level the answer cites.
- `what_if` returns `rank_changes`, computed in code. The agent names movers only from it, and the chat widget marks moved hubs "▲/▼ from N".
- The methodology states that heat and wildfire are not modeled and why, and the agent says so for "safest hubs" questions and for low Phoenix or Los Angeles scores.
- A resent question replaces the failed one, and a per-minute 429 offers Try again.
- "Ask next" no longer repeats a two-hub comparison.
- Winter and flood colors differ in lightness.
- Three new eval cases cover the what-if movers and the heat and wildfire scope. The full run after these fixes passed 44/44: tool selection 43/43, grounding 50/51 on the first try and 1/51 after one retry, 9.4 s mean and 16.9 s p95 per turn, about $1.74.

**Checked and not changed:**
- **Chicago 59.99 reads high by design.** Levels follow the shown, rounded value (60.0), so the number and its level never disagree on screen. The methodology already said so; the line was reworded to make it clearer.
- **The Los Angeles winter artifact** was already in the methodology's limitations and in the prompt: its winter days come from the mountains of a very large county.
- **The riddle and the emergency question were handled correctly:** the riddle was declined as out of scope, and the emergency got brief safety advice.
- **The "did not respond" error came from an older build:** its screenshots show the "screening priority" label and a cut-off stream, both from before the keepalive fix.
