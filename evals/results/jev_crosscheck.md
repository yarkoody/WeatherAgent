# JEV cross-check

Independent rating by TypeSafe's JEV decision model on the same raw signals. It does not affect scores or rankings; disagreements are worth an analyst's review.

Model `jev-1.14.0`, run 2026-11-17T11:30:29+00:00, snapshot data as of 2026-11-17. Command: `make jev`. JEV sees only each hub's raw signals (FEMA NRI annualized event frequencies, observed day counts, county area), not the hub's name and none of our scores, bands, weights or days-per-event assumptions. JEV's score is the expected rubric level (0 = low, 1 = medium, 2 = high); it is scaled to 0-100% and mapped to bands with our cut-offs (35% / 60%).

**Overall agreement: 40.0%** (24 of 60 hub-family ratings).
JEV calls: 15 (one per hub, 4 questions each), latency per call mean 0.3 s, max 0.4 s, whole run 1.1 s.
Tokens reported by the provider: 25,001 input / 930 output (cost is not reported).

## Agreement by family

Rank correlation compares the order of hubs (Spearman, JEV score vs our family index), which band agreement cannot: two raters can order hubs the same way and still put the cut-offs in different places.

| Family | Agree | JEV rates higher | JEV rates lower | Rank correlation |
|---|---|---|---|---|
| winter | 5/15 (33%) | 10 | 0 | +0.98 |
| flood | 2/15 (13%) | 13 | 0 | +0.57 |
| hurricane | 15/15 (100%) | 0 | 0 | +0.37 |
| severe_storm | 2/15 (13%) | 13 | 0 | +0.77 |

## Agreement by hub

Each cell: our band / JEV band (JEV score in %).

| Hub | Agree | winter | flood | hurricane | severe_storm |
|---|---|---|---|---|---|
| Atlanta Hub | 1/4 | low / medium (41.5) ✗ | low / medium (55.5) ✗ | low / low (0.5) | low / high (67.5) ✗ |
| Chicago Hub | 1/4 | medium / high (80) ✗ | low / medium (58.5) ✗ | low / low (0) | low / high (62.5) ✗ |
| Columbus Hub | 1/4 | low / high (68.5) ✗ | low / medium (50.5) ✗ | low / low (0) | low / medium (54) ✗ |
| Dallas Hub | 1/4 | low / medium (44) ✗ | low / high (68.5) ✗ | low / low (0) | low / high (78.5) ✗ |
| Detroit Hub | 1/4 | medium / high (74.5) ✗ | low / medium (49) ✗ | low / low (0) | low / high (61.5) ✗ |
| Indianapolis Hub | 1/4 | low / high (71) ✗ | low / medium (54) ✗ | low / low (0) | low / high (64.5) ✗ |
| Kansas City Hub | 1/4 | low / high (73.5) ✗ | low / medium (56) ✗ | low / low (0) | low / high (75.5) ✗ |
| Memphis Hub | 1/4 | low / medium (49.5) ✗ | low / high (71.5) ✗ | low / low (0) | low / medium (55) ✗ |
| Newark Hub | 1/4 | low / high (64) ✗ | low / high (65.5) ✗ | low / low (0.5) | low / medium (57) ✗ |
| Denver Hub | 2/4 | low / high (82) ✗ | low / low (14) | low / low (1) | low / high (64.5) ✗ |
| Houston Hub | 2/4 | low / low (25) | medium / high (84.5) ✗ | low / low (2) | low / medium (54.5) ✗ |
| Miami Hub | 2/4 | low / low (3) | low / high (74) ✗ | low / low (4) | low / medium (45.5) ✗ |
| Los Angeles Hub | 3/4 | low / low (32.5) | low / high (73) ✗ | low / low (0) | low / low (5.5) |
| Minneapolis Hub | 3/4 | high / high (95) | low / low (21.5) | low / low (1) | low / high (60.5) ✗ |
| Phoenix Hub | 3/4 | low / low (3) | low / high (80) ✗ | low / low (0) | low / low (29) |

## Disagreements (36)

| Hub | Family | Our band | JEV band | JEV score (%) |
|---|---|---|---|---|
| Atlanta Hub | flood | low | medium | 55.5 |
| Chicago Hub | flood | low | medium | 58.5 |
| Columbus Hub | flood | low | medium | 50.5 |
| Dallas Hub | flood | low | high | 68.5 |
| Detroit Hub | flood | low | medium | 49 |
| Houston Hub | flood | medium | high | 84.5 |
| Indianapolis Hub | flood | low | medium | 54 |
| Kansas City Hub | flood | low | medium | 56 |
| Los Angeles Hub | flood | low | high | 73 |
| Memphis Hub | flood | low | high | 71.5 |
| Miami Hub | flood | low | high | 74 |
| Newark Hub | flood | low | high | 65.5 |
| Phoenix Hub | flood | low | high | 80 |
| Atlanta Hub | severe_storm | low | high | 67.5 |
| Chicago Hub | severe_storm | low | high | 62.5 |
| Columbus Hub | severe_storm | low | medium | 54 |
| Dallas Hub | severe_storm | low | high | 78.5 |
| Denver Hub | severe_storm | low | high | 64.5 |
| Detroit Hub | severe_storm | low | high | 61.5 |
| Houston Hub | severe_storm | low | medium | 54.5 |
| Indianapolis Hub | severe_storm | low | high | 64.5 |
| Kansas City Hub | severe_storm | low | high | 75.5 |
| Memphis Hub | severe_storm | low | medium | 55 |
| Miami Hub | severe_storm | low | medium | 45.5 |
| Minneapolis Hub | severe_storm | low | high | 60.5 |
| Newark Hub | severe_storm | low | medium | 57 |
| Atlanta Hub | winter | low | medium | 41.5 |
| Chicago Hub | winter | medium | high | 80 |
| Columbus Hub | winter | low | high | 68.5 |
| Dallas Hub | winter | low | medium | 44 |
| Denver Hub | winter | low | high | 82 |
| Detroit Hub | winter | medium | high | 74.5 |
| Indianapolis Hub | winter | low | high | 71 |
| Kansas City Hub | winter | low | high | 73.5 |
| Memphis Hub | winter | low | medium | 49.5 |
| Newark Hub | winter | low | high | 64 |

## Interpretation

Hand-written after the run of 2026-11-17 (kept when `make jev` rewrites the tables above).

- **The bands disagree mostly on scale, not on order.** All 36 disagreements go one way: JEV rates higher, never lower. Our family index measures each family against the whole hub's cap of 25 disruption days, so a single family rarely reaches the medium cut-off (56 of our 60 family bands are low), while JEV rates each hazard on its own. The order of hubs agrees much better than the bands: rank correlation is +0.98 for winter, +0.77 for severe storms and +0.57 for flood.
- **Flood is where the two disagree on order, and it clusters in large counties and coastal-flood counties.** The largest gaps are Phoenix (county 9,319 sq mi: our flood index 4.9, JEV 80%), Los Angeles (4,797 sq mi), Miami and Houston. Our model scales county event counts down by county area (x min(1, 1000 / area)) because NRI counts events anywhere in the county. JEV was given the area but took the counts at face value. Miami, Houston, Los Angeles and Newark also have coastal-flood frequencies, which JEV weighs heavily. This matches the documented hurricane and coastal-flood overlap: part of a hurricane's impact shows up as coastal flooding.
- **Hurricane agrees 100%, but only because both raters say low for every hub.** At 0.305 events per year (Miami, the highest), JEV calls hurricanes rare. The rank correlation is weak (+0.37) because most hubs are at or near zero. For an analyst the review list is the flood ratings of Phoenix, Los Angeles, Miami and Houston, and whether the area adjustment is too strong for large counties. JEV does not change any score or ranking.
