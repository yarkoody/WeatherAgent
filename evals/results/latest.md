# Eval results

Run 2026-11-17 13:47 UTC. Model `gpt-6.1-sol`, reasoning effort `low`, snapshot data as of 2026-11-17. Command: `uv run python -m evals.run`. Expected values come from `app/scoring.py` at run time (oracle). Traces of this run: a temp directory, not the repo.

## Summary

| Metric | Value |
|---|---|
| Cases passed (all checks, all repeats) | 30/30 (100%) |
| Tool-selection accuracy (runs with tool expectations) | 29/29 (100%) |
| Grounding passed first try (all turns) | 33/36 (92%) |
| Grounding passed after one retry | 3/36 (8%) |
| Grounding failed or turn errored | 0/36 (0%) |
| Judge: names the actual top driver | 4/4 (100%) |
| Determinism | determinism_priority: 3 runs, identical ranking: yes |
| Latency per turn, mean / p95 | 10.3 s / 17.4 s (36 turns) |
| Tokens, agent (input / output) | 417,205 / 17,488 |
| Tokens, judge (input / output) | 1,401 / 132 |
| Cost estimate for this run | $1.01 (agent $1.01, judge $0.00; list prices in `app/agent.py`, cached input not discounted) |

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

Turns: 36. First try: 33. Passed after one retry: 3. Failed after the retry: 0. Turn errors: 0.

For each retried or failed turn, every grounding error: what the model cited (tool.field [family] @hub = value) and which field of that turn's tool results actually holds the number (tools re-run offline).

| Case, turn | Status | Attempt | Error kind | Model cited | Field that holds the number |
|---|---|---|---|---|---|
| followup_first_one t2 | retried | first | figure | 'Winter share of typical-year disruption exposure': get_hub_risk.winter @minneapolis = 83.5 | get_hub_risk.family_weights [winter] |
| miami_typical_vs_bad t1 | retried | first | text number | mentions 20, which is not in figures. Add it to figures or remove it. | - |
| history_minneapolis t1 | retried | first | figure | 'Worst observed year winter days': get_hub_history.winter [winter] @minneapolis = 53 | get_hub_history.days [winter] |

## Per case

Latency is per run, all turns summed; repeated cases show one value per run.

| Case | Result | Tools called (last turn) | Grounding | Judge | Latency (s) | Failed checks |
|---|---|---|---|---|---|---|
| brief_midwest_winter | PASS | rank_hubs | pass | - | 8.5 |  |
| brief_miami_houston | PASS | compare_hubs | pass | - | 10.4 |  |
| brief_denver_snow | PASS | weather_stat | pass | - | 7.4 |  |
| brief_dallas_why_high | PASS | get_hub_risk | pass | pass | 9.0 |  |
| para_midwest_rank | PASS | rank_hubs | pass | - | 9.5 |  |
| para_priority_top5 | PASS | rank_hubs,compare_hubs | pass | - | 13.6 |  |
| para_houston_miami | PASS | compare_hubs | pass | - | 9.2 |  |
| para_chicago_snow | PASS | weather_stat | pass | - | 7.4 |  |
| para_kc_drivers | PASS | get_hub_risk | pass | pass | 9.0 |  |
| followup_first_one | PASS | get_hub_risk | retried | pass | 23.5 |  |
| followup_and_chicago | PASS | weather_stat | pass | - | 14.2 |  |
| determinism_priority | PASS | rank_hubs / rank_hubs / rank_hubs | pass/pass/pass | -/-/- | 16.5/15.3/15.2 |  |
| premise_atlanta | PASS | get_hub_risk | pass | - | 11.0 |  |
| missing_boise | PASS | get_hub_risk,list_hubs | pass | - | 9.9 |  |
| missing_lightning | PASS | - | pass | - | 5.7 |  |
| missing_year_1950 | PASS | weather_stat | pass | - | 5.6 |  |
| out_of_scope_stock | PASS | - | pass | - | 3.6 |  |
| injection_miami_safest | PASS | rank_hubs | pass | - | 9.0 |  |
| ambiguous_riskiest | PASS | rank_hubs,get_hub_risk | pass | - | 10.4 |  |
| what_if_costs | PASS | what_if | pass | - | 9.4 |  |
| live_alerts_houston | PASS | get_active_alerts | pass | - | 6.6 |  |
| invest_recommendation | PASS | rank_hubs,compare_hubs | pass | - | 14.0 |  |
| invest_followup_costs | PASS | what_if | pass | - | 30.0 |  |
| population_compact | PASS | get_hub_risk | pass | - | 7.0 |  |
| bad_year_ranking | PASS | rank_hubs,compare_hubs | pass | - | 12.8 |  |
| miami_typical_vs_bad | PASS | get_hub_risk | retried | pass | 17.4 |  |
| metro_new_york | PASS | get_hub_risk | pass | - | 9.4 |  |
| metro_boston_followup | PASS | get_hub_risk | pass | - | 15.4 |  |
| ambiguous_portland | PASS | get_hub_risk | pass | - | 5.7 |  |
| history_minneapolis | PASS | get_hub_history,get_hub_risk | retried | - | 19.0 |  |

## Failure analysis

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
