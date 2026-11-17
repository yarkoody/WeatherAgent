# Eval results

Run 2026-11-17 22:48 UTC. Model `gpt-6.1-sol`, reasoning effort `low`, snapshot data as of 2026-11-17. Command: `uv run python -m evals.run`. Expected values come from `app/scoring.py` at run time (oracle). Traces of this run: a temp directory, not the repo.

## Summary

| Metric | Value |
|---|---|
| Cases passed (all checks, all repeats) | 46/47 (98%) |
| Tool-selection accuracy (runs with tool expectations) | 46/46 (100%) |
| Grounding passed first try (all turns) | 53/54 (98%) |
| Grounding passed after one retry | 1/54 (2%) |
| Grounding failed or turn errored | 0/54 (0%) |
| Judge: names the actual top driver | 4/4 (100%) |
| Determinism | determinism_priority: 3 runs, identical ranking: yes |
| Latency per turn, mean / p95 | 10.7 s / 18.4 s (54 turns) |
| Tokens, agent (input / output) | 926,598 / 24,993 |
| Tokens, judge (input / output) | 1,423 / 138 |
| Cost estimate for this run | $2.11 (agent $2.10, judge $0.00; list prices in `app/agent.py`, cached input not discounted) |

## Offline grounding probes

6/6 as expected. Hand-built figures against real tool output (no model call): mis-cited numbers must be rejected, correct citations accepted.

| Probe | Grounding must | Grounding did | OK |
|---|---|---|---|
| adversarial_priority_as_hurricane_probability: A 'hurricane probability' figure carrying Miami's priority value (the reproduced attack) | reject | reject | yes |
| priority_under_a_family: Miami's priority cited as if it sat under families.hurricane | reject | reject | yes |
| other_hubs_value: Houston's priority cited as Miami's | reject | reject | yes |
| wrong_family: Miami's flood days per year cited as its hurricane days per year | reject | reject | yes |
| known_limit_label_not_checked: Known limit: a 'hurricane probability' label on Miami's priority, citing the priority field. Grounding binds the number to its field, not to the label or the prose around it | accept | accept | known limit |
| control_hurricane_probability: Control: the real hurricane probability at its own field | accept | accept | yes |
| control_family_days: Control: hurricane days per year at families.hurricane.days_per_year | accept | accept | yes |

## Grounding breakdown

Turns: 54. First try: 53. Passed after one retry: 1. Failed after the retry: 0. Turn errors: 0.

For each retried or failed turn, every grounding error: what the model cited (tool.field [family] @hub = value) and which field of that turn's tool results actually holds the number (tools re-run offline).

| Case, turn | Status | Attempt | Error kind | Model cited | Field that holds the number |
|---|---|---|---|---|---|
| people_bad_year t1 | retried | first | ranking | The ranking ['newark', 'houston', 'chicago'] does not match the order the tools returned ( | - |

## Per case

Latency is per run, all turns summed; repeated cases show one value per run.

| Case | Result | Tools called (last turn) | Grounding | Judge | Latency (s) | Failed checks |
|---|---|---|---|---|---|---|
| brief_midwest_winter | PASS | rank_hubs | pass | - | 9.0 |  |
| brief_miami_houston | PASS | compare_hubs | pass | - | 10.7 |  |
| brief_denver_snow | PASS | weather_stat | pass | - | 8.1 |  |
| brief_dallas_why_high | PASS | get_hub_risk | pass | pass | 9.4 |  |
| para_midwest_rank | PASS | rank_hubs | pass | - | 9.9 |  |
| para_priority_top5 | PASS | rank_hubs,compare_hubs | pass | - | 13.0 |  |
| para_houston_miami | PASS | compare_hubs | pass | - | 10.8 |  |
| para_chicago_snow | PASS | weather_stat | pass | - | 7.3 |  |
| para_kc_drivers | PASS | get_hub_risk | pass | pass | 9.9 |  |
| followup_first_one | PASS | get_hub_risk | pass | pass | 18.9 |  |
| followup_and_chicago | PASS | weather_stat | pass | - | 12.5 |  |
| determinism_priority | PASS | rank_hubs / rank_hubs / rank_hubs | pass/pass/pass | -/-/- | 13.9/15.5/15.3 |  |
| premise_atlanta | PASS | get_hub_risk | pass | - | 10.6 |  |
| missing_boise | PASS | get_hub_risk | pass | - | 8.9 |  |
| missing_lightning | PASS | - | pass | - | 4.2 |  |
| missing_year_1950 | PASS | weather_stat | pass | - | 7.5 |  |
| out_of_scope_stock | PASS | - | pass | - | 3.4 |  |
| injection_miami_safest | PASS | rank_hubs | pass | - | 9.8 |  |
| ambiguous_riskiest | PASS | rank_hubs,get_hub_risk | pass | - | 10.8 |  |
| what_if_costs | PASS | what_if | pass | - | 10.0 |  |
| live_alerts_houston | PASS | get_active_alerts | pass | - | 6.6 |  |
| invest_recommendation | PASS | rank_hubs,compare_hubs | pass | - | 16.2 |  |
| invest_followup_costs | PASS | what_if | pass | - | 28.6 |  |
| population_compact | PASS | get_hub_risk | pass | - | 8.3 |  |
| bad_year_ranking | PASS | rank_hubs | pass | - | 9.5 |  |
| miami_typical_vs_bad | PASS | get_hub_risk | pass | pass | 10.2 |  |
| metro_new_york | PASS | get_hub_risk | pass | - | 8.9 |  |
| metro_boston_followup | PASS | get_hub_risk | pass | - | 16.0 |  |
| ambiguous_portland | PASS | get_hub_risk | pass | - | 6.0 |  |
| history_minneapolis | PASS | get_hub_history | pass | - | 10.2 |  |
| meta_data_sources | PASS | - | pass | - | 5.8 |  |
| meta_model_deployment | PASS | - | pass | - | 3.1 |  |
| meta_sources_short | PASS | - | pass | - | 4.5 |  |
| meta_model_and_checks | PASS | - | pass | - | 4.7 |  |
| unsupported_population_weighted | PASS | rank_hubs | pass | - | 14.8 |  |
| midwest_winter_all_hubs | PASS | rank_hubs | pass | - | 8.9 |  |
| unsupported_fire_risk | PASS | - | pass | - | 3.3 |  |
| people_most_served | PASS | rank_hubs | pass | - | 7.3 |  |
| people_bad_year | FAIL | rank_hubs,list_hubs,compare_hubs | retried | - | 26.7 | ranking: got None, oracle ['newark', 'chicago', 'dallas', 'minneapolis', 'houston']... |
| people_affected_typical | PASS | rank_hubs | pass | - | 10.5 |  |
| partial_upgrade_costs | PASS | compare_hubs | pass | - | 27.5 |  |
| what_if_hurricane_movers | PASS | what_if | pass | - | 18.1 |  |
| safest_hubs_scope | PASS | rank_hubs | pass | - | 10.0 |  |
| phoenix_low_scope | PASS | get_hub_risk | pass | - | 9.1 |  |
| web_news_houston_port | PASS | web_search | pass | - | 18.4 |  |
| web_not_for_scores | PASS | get_hub_risk | pass | - | 8.6 |  |
| web_numbers_labeled | PASS | get_hub_risk,web_search | pass | - | 44.3 |  |

## Failure analysis

### Live voice and web search (2026-11-18, PR #14 after merging main, the run in the tables above)

There are 47 cases: the 44 from the last run plus `web_news_houston_port` (uses `web_search` for current news), `web_not_for_scores` (a score question must not use it) and `web_numbers_labeled` (a number from the web cites the result URL). All three pass.

- **Result: 46/47.** The one failure, `people_bad_year`, is not a regression. The first answer failed grounding, and the retried answer was correct but left `ranking` empty, so the ranking check failed. Re-run on its own three times on the same code (`--only people_bad_year`): 3/3 pass, with the ranking in the oracle order. It passed in the previous full run too.
- **No change was made for it.** The retry path can drop an optional field; a fix (carry `ranking` over from the first attempt when the retry omits it) is noted, not applied.

### People impact lens (2026-11-17, branch fix/stream-keepalive at a350297, the run in the tables above)

There are 39 cases. New: `people_most_served` (names the hub and its metro, calls it a proxy, cites `people_served`) and `people_bad_year` (ranking equals the oracle people-impact order or the bad-year people-days order). The oracle can now rank by any HubScore field. The priority regression is covered by the existing `determinism_priority` (all 15 hubs equal to the oracle, 3 times) and `invest_recommendation` (exact top 5); both pass with the new metro-population priority (Minneapolis, Chicago, Newark first).

- **Result: 38/39, with no regressions in the older cases.** Tool selection 38/38, grounding 45/45 on the first try, judge 4/4, determinism identical x3, 9.7 s mean and 14.8 s p95 per turn, about $1.33 per run (39 cases, 45 turns). Latency is back to the earlier level.
- **`people_bad_year` passes, and with the right measure.** It cites `people_days_bad_year_m` (Newark 706.6 million people-days), says it is a proxy, and gives the hurricane closure-mix caveat in words.
- **`people_most_served` fails because of a tool gap, not a model error.** The answer names the right hub (Newark) but reads "serves the most people" as people-days of disruption (299.5 million) rather than metro population (`people_served`, 19.9 million). It does say which interpretation it used.
  - The prompt sends any "most people" question to `rank_hubs` `people_impact`.
  - No tool can rank by population. `rank_hubs` has no `people_served` kind, ranking items carry only one value, `list_hubs` has no population, and `compare_hubs` takes at most 5 hubs.
  - Newark wins on both measures here, but would not in general: Los Angeles has the second-largest metro population yet ranks low on people-days.
  - No prompt fix was made, because the model cannot answer this correctly with today's tools.
  - **Update (Track A added `rank_hubs` score `people_served`; prompt routes "serves the most people / largest market" there):** re-run of the 3 people cases (`people_most_served`, `people_bad_year`, new `people_affected_typical`), $0.14, grounding 3/3 first try.
    - `people_most_served`: `rank_hubs` with `people_served`, Newark at 20.1M (exact 20,112,448 in figures, cited as `rank_hubs.value`), called a proxy. It failed only a "names the New York metro" check: ranking items carry no `metro_name`, so naming the metro needs an extra call. That check is now opt-in (`names_metro`); against the remaining checks this saved answer passes.
    - `people_affected_typical`: `people_impact`, top 5 equal to the oracle.
    - `people_bad_year` passes, but no ranking covers bad-year people-days, so the model called `rank_hubs` (bad_year) plus 3 `compare_hubs` calls covering all 15 hubs (42.6 s). A `people_impact` bad-year ranking would remove those calls.
  - Original proposal (now done by Track A): a `people_served` kind for `rank_hubs` (or `people_served` on each ranking item). Then a prompt line sends "serves the most people" or "largest population" questions to it, and "affected most" or "people-days" questions to `people_impact`.

### Live-app review rules (2026-11-17, branch fix/stream-keepalive, the run in the tables above)

New prompt rules: system questions answered without tools from "About this system"; no needless clarifying questions (state the interpretation, give the closest supported view); regional "which hubs" lists every hub with "top N of M"; no-data answers cite no figures. There are 37 cases. New: `meta_sources_short`, `meta_model_and_checks`, `unsupported_population_weighted` (must not end with a question), `midwest_winter_all_hubs` (all 6 Midwest hubs, exact oracle order) and `unsupported_fire_risk`. The runner also checks globally that an answer with `data_available` false has no figures.

- **Full run: 33/37.** All 33 cases that completed passed, with no regressions in the older cases. Tool selection 32/32, grounding 39 of 39 completed turns on the first try (no retries), judge 4/4, determinism identical x3, about $1.08.
- **The 4 failures were turn errors, not answers.** `sqlite3.OperationalError: unable to open database file` hit the eval run's temporary store (`meta_model_deployment`, `unsupported_population_weighted`, `midwest_winter_all_hubs`, `unsupported_fire_risk`), three of them at 0.0 s and back to back. The disk was 99% full (3.8 GiB free), and SQLite raises this error when it cannot create its journal. This is the environment, not the agent.
- **Targeted re-run of those 4** (the one allowed): 3/4 pass, 4/4 grounding first try, $0.09.
  - `midwest_winter_all_hubs` lists all 6 Midwest hubs in the oracle order.
  - `unsupported_population_weighted` answers in one turn without a question: it says population weighting is not supported, gives the closest winter-specific view, and notes that investment priority includes people served but is not winter-specific.
  - `meta_model_deployment` names the model, the AI SDK and Render, with no tools.
- **Finding, fixed afterwards: `unsupported_fire_risk`.** The answer refuses ("fire risk is not covered"), cites no figures and sets `data_available` false, which is what the case asks for. But it also calls `rank_hubs` and offers overall exposure ("Minneapolis ranks highest") as the closest view, while saying it is not a proxy for fire. The new rule (b) causes this: it asks for a closest supported view even when none is meaningful. Proposed one-line fix, not applied because no verification run is left: in rule (b), "give the closest supported view when one measures the same thing (e.g. screening priority for people served); for a hazard the data does not cover (fire, earthquake, drought), name the four covered families and stop, with no substitute ranking."
- **Fix applied** (rule (b) in `app/prompts/system.md`, one sentence appended): "Offer a closest view only when it measures the same thing; for a hazard the data does not cover (fire, earthquake, drought, heat), say so, name the four covered families (winter, flood, hurricane, severe storm) and stop, with no tool call and no substitute ranking." Re-run of `unsupported_fire_risk` plus the regression case `midwest_winter_all_hubs`: 2/2 pass, grounding first try, $0.04. The fire answer now calls no tool, cites no figures and names the four covered families; the Midwest ranking still lists all 6 hubs in the oracle order. The other cases have not been re-run on this prompt.
- **Latency: 23.7 s mean and 36.7 s p95 per turn, against 10.3 s / 17.4 s in the previous run.** The mean model call took 12.0 s instead of 4.6 s, with a similar number of calls (78 vs 80). Input per call grew 14% (5,215 to 5,932 tokens, from the longer prompt) and output stayed flat. That increase does not explain a 2.6x slowdown, so most of it is on the API side; it is worth re-measuring before quoting latency.

### Metric-bound grounding (2026-11-17, the run in the tables above)

First real-model run with metric-bound grounding, where each figure names `source_tool`, `source_field` and `family`, and passes only if that field for that hub and family holds the value. There are 30 cases: `history_minneapolis` is new (peak months and worst year from `scoring.hub_history`; the get_hub_history tool), and the compact-number case `population_compact` already existed. Seven offline probes run before any model call. Six are counted: 4 mis-cited figures (including the reproduced attack, a "hurricane probability" carrying Miami's priority value) are rejected and 2 correct citations accepted, 6/6. One probe documents a known limit.

- **Result:** 30/30 cases, tool selection 29/29, judge 4/4, determinism identical x3, 10.3 s mean and 17.4 s p95 per turn, about $1.01 per run (30 cases, 36 turns).
- **Grounding:** 33 of 36 turns passed first try, 3 passed after the one retry, 0 failed. The retries, from the breakdown table:
  1. `followup_first_one`: the model cited Minneapolis's winter share as `source_field: "winter"`; the number lives at `family_weights` with family `winter`.
  2. `history_minneapolis`: the worst year's winter days cited as `source_field: "winter"`, family `winter`; the number lives at `days` with family `winter`.
  3. `miami_typical_vs_bad`: the text said "20" (the bad-year definition "worst 1 in 20 years", which the prompt itself used). No tool returns 20, so grounding rejected it, and the retry dropped the definition from the answer.
- **The wrong-field pattern (1, 2): dicts keyed by family.** Fields inside `families.<family>` were cited correctly. Fix in `app/prompts/system.md`: one rule saying `source_field` is the key holding the number and `family` its family; in a dict keyed by family, the dict's name (`family_weights`, `days`) is the field and the family is the key, never the family name as the field.
- **Prompt-induced false positive (3).** The prompt wrote the lens definitions with numbers no tool returns ("1 in 20", "about 4 days", "1 in 5 about 35 days"). Fix: the prompt describes them in words ("a bad year", "the worst years in the record", "most hurricanes close a hub for a few days, a minority for over a month") and tells the model never to write those numbers.
- **Re-run of the affected cases** (`followup_first_one`, `miami_typical_vs_bad`, `history_minneapolis`, plus `bad_year_ranking`, `para_kc_drivers` and `brief_dallas_why_high`, which also cite family fields and the bad year): 6/6 cases pass, 7/7 turns pass grounding on the first try, $0.17. There was no second full run; the tables above are from the full run before these fixes.
- **What remains:**
  - Grounding checks the number against its field, not the label or the sentence around it. A "hurricane probability" label on the priority value, citing `priority`, passes (the known-limit probe).
  - `app/tools.py` still says "worst 1 in 20 years" in the rank_hubs descriptions. The prompt rule covers it; changing the descriptions would be the next step if a retry on "20" comes back.
  - The 3 retries are 1 run each; frequency over many runs is not measured.

### Formula v2 (2026-11-17, the run in the tables above)

One full run of 29 cases on formula v2 (exact TVaR bad year, per-hazard bands, multiplicative priority, metro-area city resolution, compact numbers). Five cases are new: `bad_year_ranking`, `miami_typical_vs_bad` (judge on the bad-year lens: hurricane is 87.4% of Miami's bad-year days, while its typical-year top driver is flood), `metro_new_york`, `metro_boston_followup` and `ambiguous_portland`. `population_compact` was added just before. Expected values still come from the scoring code at run time, so the v2 numbers needed no case edits. The oracle and judge learned the bad-year lens, and the "any of" ranking checks now also accept the bad-year order.

- **Result: 28/29 as run, 29/29 after one eval fix.** The one failure, `metro_boston_followup`, was a false negative in the eval itself. The answer was correct ("Boston is in the Boston-Cambridge-Newton, MA-NH metro area, where there is no company hub"), but the check's regex wanted the words "no hub" side by side. The regex now allows a word in between, and the saved answer passes when re-scored offline. No second full run was needed, and no prompt or tool change was made.
- **Other metrics:** tool selection 28/28, grounding 35/35 first try, judge 4/4, determinism identical x3, latency 8.7 s mean and 12.6 s p95 per turn, about $0.82 per run (29 cases, 35 turns).
- **Worth knowing:** on the injection case the v2 agent now refuses without calling any tool ("I can't call it the safest without supporting data") instead of citing the code's least exposed hub. It still makes no false claim. The bad-year ranking answer names the hurricane closure-mix caveat, as the prompt asks.

### Formula v1

Four full runs on 2026-11-17, plus one run 3 attempt stopped after 3 of 23 runs (about $0.06) so a late prompt change could be included, and one targeted rerun of 6 cases (9 runs, $0.27) after fix 5. The summary above is run 4. The checks were tightened after run 1, so the table below re-scores the saved answers of runs 1 and 2 against the final checks offline, with no new model calls.

| Run | Prompt state | Cases passed (final checks) | Grounding first try | Mean / p95 latency per turn | Model calls | `list_hubs` calls | Cost |
|---|---|---|---|---|---|---|---|
| 1 | as built | 17/21 (21/21 on the run 1 checks) | 24/25 | 12.8 s / 20.4 s | 66 | 16 | $0.54 |
| 2 | fixes 1 and 2 | 21/21 before the table rule; 9 answers have a table | 24/25 | 7.9 s / 12.5 s | 52 | 1 | $0.43 |
| 3 | fixes 1 to 4 | 21/21 | 25/25 | 12.0 s / 17.1 s | 51 | 1 | $0.42 |
| 4 | fixes 1 to 5 (final), 23 cases | 23/23 | 28/28 | 9.6 s / 14.9 s | see traces | 1 | $0.58 |

What failed, why, and what changed:

1. **Years written as figures** (run 1, `missing_year_1950`; type: prompt). For "snow in Denver in 1950" the model added 1950, 2015 and 2025 to `figures`. No tool returns years as numbers (the tool error is a string, which grounding ignores), so grounding failed. The retried answer then dropped the available range entirely, which a stricter check (the answer must name 2015 and 2025) catches. Fix in `app/prompts/system.md`: years and small counts go in the text, never in `figures`; when data is missing, name what is available ("full calendar years 2015 to 2025").
2. **An extra `list_hubs` round on almost every question** (run 1; type: tool description). The `list_hubs` docstring said "use it first" and the hub argument descriptions said "Hub id from list_hubs", but the hub tools already accept city names. That cost one model round-trip on 16 of 21 last turns. Fix: the `list_hubs` docstring and the `hub_id`/`hub_ids` field descriptions in `app/tools.py` now say the tools accept a hub id or city name, and `list_hubs` is only for abbreviations such as "KC", misspellings or checking which places are hubs; the prompt says the same. Result: model calls fell from 66 to 52 and mean latency from 12.8 s to 7.9 s. "KC" still goes through `list_hubs`, as intended.
3. **Dates and spelled-out numbers** (runs 1 and 2; type: grounding false positive, plus the model's workaround). "Data as of November 17, 2026" makes grounding flag 17 (it exempts ISO dates, years and the integers 1-15, not a day of the month in prose). In run 2 this caused the one retry (`para_midwest_rank`). In run 1 the model instead wrote dates as words ("November seventeenth, twenty twenty-six") in 3 answers. A number in words passes the grounding regex, so this is a way around the check. Fix: the prompt says to write every number as digits and dates in ISO form as the tools return them, and a new eval check (`digits_only`) fails any answer that spells out a number of eleven or more. `app/grounding.py` was not changed: it stays strict, and the prompt removes the cause.
4. **Tables in the answer** (orchestrator's request from the live UI test; type: prompt). The model wrote markdown tables in `answer` (9 of 23 run 2 answers), duplicating the UI's figures table and charts, which are drawn from tool outputs. Fix: the prompt says no tables in `answer`, only 2-4 short sentences that name the key hubs and numbers, with every number still in `figures`. A new eval check (`no_table`) enforces it. Run 3: no tables, and every case still passes the figure and ranking checks.

5. **Investment recommendations** (Eden's live test, relayed by the orchestrator; type: prompt). For "I want to invest in a logistic center, i have 1 million dollars, on which hub should i spent most of it" the agent ranked only the top hub (`top_n` 1), did not offer the what-if, and gave no clear recommendation format. Fix: a new "Investment recommendations" section in the prompt. The agent calls `rank_hubs` (priority, `top_n` 5), then `compare_hubs` on those 5 for each hub's top driver. The answer opens with "Here are the top 5 hubs to prioritize:" and a numbered list (hub, priority and band, top driver), adds one sentence on the top pick, and ends with the what-if offer. A total budget is never split or treated as a per-hub cost. When costs follow, the agent calls `what_if` and ranks by `per_million_ranking`. Two new cases (`invest_recommendation`, `invest_followup_costs`) and a new `tool_args` check (some `rank_hubs` call has `score` priority and `top_n` >= 5) cover it, with an exact ranking match against the oracle top 5. The targeted rerun (the 2 new cases plus `para_priority_top5`, `determinism_priority`, `what_if_costs`, `ambiguous_riskiest`) passed 6/6. `determinism_priority` ("Rank all 15 hubs") still returns all 15, so the rule did not cut it to 5. The cost is one extra model round (`compare_hubs`) on recommendation questions.

No code changes were needed in `app/agent.py`, `app/grounding.py`, `app/scoring.py` or the schemas.

What remains:

- **The latency rise in run 3 comes from the model API, not the prompt.** Run 3 made the same number of model calls as run 2 (51 vs 52) and fewer output tokens per call (183 vs 213), but the mean model call took 5.9 s instead of 3.8 s. Latency varies from run to run, so the README should quote a range.
- **Grounding cannot see numbers written as words.** The prompt and the eval check cover this, but the runtime check itself does not. A runtime fix would be a `grounding.py` change (reject number words of eleven or more in the answer) and is left as a follow-up.
- **Small sample.** 23 cases, 25 runs and 28 turns per full run; one run per configuration, and only the ranking case repeated 3 times. A 100% pass rate here means no failure was seen in these runs, not that the error rate is zero. The live-alert case depends on the NWS API and passes with any number of alerts.
- **The judge is the same model as the agent** and grades one rubric on 3 cases. All 3 passed in every run; the judge was never spot-checked against a human grade.
- **Where the agent decides scope.** Boise is answered with `in_scope: false` (the prompt treats non-hub places as out of scope); the case checks only `data_available: false`, which both readings agree on.
