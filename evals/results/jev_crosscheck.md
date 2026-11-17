# JEV cross-check

Independent rating by TypeSafe's JEV decision model on the same raw signals. It does not affect scores or rankings; disagreements are worth an analyst's review.

Model `jev-1.14.0`, run 2026-11-17T12:26:52+00:00, snapshot data as of 2026-11-17. Command: `make jev`. JEV sees only each hub's raw signals (FEMA NRI annualized event frequencies, observed day counts, county area), not the hub's name and none of our scores, bands, weights or days-per-event assumptions. JEV's score is the expected rubric level (0 = low, 1 = medium, 2 = high); it is scaled to 0-100% and mapped to bands with our cut-offs (35% / 60%).

**Overall agreement: 65.0%** (39 of 60 hub-family ratings).
JEV calls: 15, latency per call mean 0.2 s, max 0.4 s, whole run 1.0 s.
Tokens reported by the provider: 25,008 input / 930 output (cost is not reported).

## Agreement by family

Our band is the formula's per-family band (by days per year; hurricane by 10-year probability). Rank correlation compares the order of hubs (Spearman, JEV score vs our family days per year), which band agreement cannot: two raters can order hubs the same way and still put the cut-offs in different places.

| Family | Agree | JEV rates higher | JEV rates lower | Rank correlation |
|---|---|---|---|---|
| winter | 15/15 (100%) | 0 | 0 | +0.98 |
| flood | 9/15 (60%) | 4 | 2 | +0.22 |
| hurricane | 10/15 (67%) | 0 | 5 | +0.35 |
| severe_storm | 5/15 (33%) | 10 | 0 | +0.84 |

## Agreement by hub

Each cell: our band / JEV band (JEV score in %).

| Hub | Agree | winter | flood | hurricane | severe_storm |
|---|---|---|---|---|---|
| Miami Hub | 1/4 | low / low (2.5) | medium / high (72) ✗ | high / low (5.5) ✗ | low / medium (48) ✗ |
| Newark Hub | 1/4 | high / high (69) | medium / high (67) ✗ | high / low (1) ✗ | medium / high (63) ✗ |
| Atlanta Hub | 2/4 | medium / medium (41.5) | medium / medium (56.5) | medium / low (0) ✗ | medium / high (69.5) ✗ |
| Houston Hub | 2/4 | low / low (24.5) | high / high (84.5) | high / low (2.5) ✗ | low / medium (57) ✗ |
| Kansas City Hub | 2/4 | high / high (69) | high / medium (57) ✗ | low / low (0) | medium / high (76) ✗ |
| Chicago Hub | 3/4 | high / high (81) | medium / medium (57) | low / low (0) | medium / high (62.5) ✗ |
| Dallas Hub | 3/4 | medium / medium (44.5) | high / high (67.5) | low / low (0) | medium / high (78) ✗ |
| Denver Hub | 3/4 | high / high (90.5) | low / low (17.5) | low / low (1) | medium / high (63.5) ✗ |
| Detroit Hub | 3/4 | high / high (82) | medium / medium (45.5) | low / low (0) | medium / high (62) ✗ |
| Indianapolis Hub | 3/4 | high / high (75) | medium / medium (47) | low / low (0) | medium / high (64) ✗ |
| Los Angeles Hub | 3/4 | medium / medium (35.5) | low / high (71.5) ✗ | low / low (0) | low / low (7) |
| Memphis Hub | 3/4 | medium / medium (52) | high / high (69.5) | medium / low (0) ✗ | medium / medium (57.5) |
| Minneapolis Hub | 3/4 | high / high (97.5) | medium / low (16.5) ✗ | low / low (1) | medium / medium (56) |
| Phoenix Hub | 3/4 | low / low (2.5) | low / high (82.5) ✗ | low / low (0) | low / low (29.5) |
| Columbus Hub | 4/4 | high / high (71.5) | medium / medium (47.5) | low / low (0) | medium / medium (54.5) |

## Disagreements (21)

| Hub | Family | Our band | JEV band | JEV score (%) |
|---|---|---|---|---|
| Kansas City Hub | flood | high | medium | 57 |
| Los Angeles Hub | flood | low | high | 71.5 |
| Miami Hub | flood | medium | high | 72 |
| Minneapolis Hub | flood | medium | low | 16.5 |
| Newark Hub | flood | medium | high | 67 |
| Phoenix Hub | flood | low | high | 82.5 |
| Atlanta Hub | hurricane | medium | low | 0 |
| Houston Hub | hurricane | high | low | 2.5 |
| Memphis Hub | hurricane | medium | low | 0 |
| Miami Hub | hurricane | high | low | 5.5 |
| Newark Hub | hurricane | high | low | 1 |
| Atlanta Hub | severe_storm | medium | high | 69.5 |
| Chicago Hub | severe_storm | medium | high | 62.5 |
| Dallas Hub | severe_storm | medium | high | 78 |
| Denver Hub | severe_storm | medium | high | 63.5 |
| Detroit Hub | severe_storm | medium | high | 62 |
| Houston Hub | severe_storm | low | medium | 57 |
| Indianapolis Hub | severe_storm | medium | high | 64 |
| Kansas City Hub | severe_storm | medium | high | 76 |
| Miami Hub | severe_storm | low | medium | 48 |
| Newark Hub | severe_storm | medium | high | 63 |

## Interpretation

Hand-written after the formula v2 run of 2026-11-17 (kept when `make jev` rewrites the tables above).

- **Band agreement rose from 40.0% (formula v1) to 65.0% (v2).** v1 compared JEV with bands derived from each family's 0-100 index on the whole hub's 25-day cap, so 56 of our 60 family bands were low and every disagreement had JEV higher. v2 gives each family its own band (by days per year; hurricane by 10-year probability), so both raters now judge a hazard on its own scale. Winter agrees on all 15 hubs and orders them almost identically (rank correlation +0.98). Severe storms keep the same order (+0.84) but JEV puts its cut-offs lower: 10 of 15 are rated higher by JEV, none lower.
- **Flood is the weakest order (+0.22, down from +0.57), and the outliers are the same kind of hub as in v1.** These are large counties: Phoenix (9,319 sq mi, our 1.2 days per year, JEV 82.5%) and Los Angeles (4,797 sq mi, 1.6 days, JEV 71.5%). The rest are coastal-flood counties: Miami and Newark. Our model scales county event counts down by county area, and JEV takes them at face value. JEV also weighs coastal flooding heavily, which is the documented hurricane and coastal-flood overlap.
- **Hurricane disagreements come from how the question is posed, not from the data.** We rate Miami (95.3% chance of at least one hurricane-class storm in 10 years), Houston and Newark high, and Atlanta and Memphis medium. JEV rates all five low, because its criteria ask whether a hazard is a frequent, recurring cause of lost days, and 0.3 events a year reads as rare. A JEV question phrased as "how likely is a damaging strike in 10 years" would test our hurricane band directly. Until then, the analyst review list is the flood ratings of Phoenix, Los Angeles, Miami and Newark. JEV does not change any score or ranking.
