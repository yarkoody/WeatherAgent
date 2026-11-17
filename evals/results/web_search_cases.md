# Eval results

Run 2026-11-17 22:06 UTC. Model `gpt-6.1-sol`, reasoning effort `low`, snapshot data as of 2026-11-17. Command: `uv run python -m evals.run --only web_news_houston_port,web_not_for_scores,web_numbers_labeled`. Expected values come from `app/scoring.py` at run time (oracle). Traces of this run: a temp directory, not the repo.

## Summary

| Metric | Value |
|---|---|
| Cases passed (all checks, all repeats) | 3/3 (100%) |
| Tool-selection accuracy (runs with tool expectations) | 3/3 (100%) |
| Grounding passed first try (all turns) | 3/3 (100%) |
| Grounding passed after one retry | 0/3 (0%) |
| Grounding failed or turn errored | 0/3 (0%) |
| Judge: names the actual top driver | n/a |
| Determinism | n/a |
| Latency per turn, mean / p95 | 24.8 s / 43.5 s (3 turns) |
| Tokens, agent (input / output) | 54,063 / 1,104 |
| Tokens, judge (input / output) | 0 / 0 |
| Cost estimate for this run | $0.12 (agent $0.12, judge $0.00; list prices in `app/agent.py`, cached input not discounted) |

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

Turns: 3. First try: 3. Passed after one retry: 0. Failed after the retry: 0. Turn errors: 0.

No grounding errors in this run.

## Per case

Latency is per run, all turns summed; repeated cases show one value per run.

| Case | Result | Tools called (last turn) | Grounding | Judge | Latency (s) | Failed checks |
|---|---|---|---|---|---|---|
| web_news_houston_port | PASS | web_search | pass | - | 21.2 |  |
| web_not_for_scores | PASS | get_hub_risk | pass | - | 9.6 |  |
| web_numbers_labeled | PASS | get_hub_risk,web_search | pass | - | 43.5 |  |
