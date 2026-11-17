# Scoring methodology

How every number in the Weather Risk Intelligence Agent is computed. This file is the single source of truth for the math: each formula below is what `app/scoring.py` does, and section 7 shows every intermediate number for two hubs, printed by the code, so you can check them by hand.

All weights, caps and thresholds live in one place, `ScoringConfig` in `app/scoring.py`. Scoring is deterministic: the same snapshot and config always give the same numbers. Every figure is computed from unrounded values and rounded to one decimal only for display; bands follow the displayed value.

## Contents

1. [Data sources](#1-data-sources)
2. [Typical year: expected disruption days](#2-typical-year-expected-disruption-days)
3. [Hurricane: chance in 10 years](#3-hurricane-chance-in-10-years)
4. [Bad year: the worst 1 in 20 years](#4-bad-year-the-worst-1-in-20-years)
5. [Review priority](#5-review-priority)
6. [People served and people-days](#6-people-served-and-people-days)
7. [Worked example: Miami and Minneapolis](#7-worked-example-miami-and-minneapolis)
8. [Sensitivity and limitations](#8-sensitivity-and-limitations)

## 1. Data sources

Everything is public and needs no API key. A refresh (`make data`) writes a committed snapshot, and `data/snapshot/provenance.json` records what period or vintage each source covers and when it was fetched.

| Source | What we use | Period or vintage | Fetched |
|---|---|---|---|
| FEMA National Risk Index (counties) | annualized event frequency per hazard, county area, coastal-flood exposed area, community resilience score | release December 2025 (long-term modeled frequencies) | 2026-11-17 |
| Open-Meteo Historical Weather API (ERA5 reanalysis) | daily snowfall, precipitation, max wind gust, min temperature at the hub point | 2015-01-01 to 2025-12-31 | 2026-11-17 |
| Census Bureau population estimates | metro-area (CBSA) population | Vintage 2025, July 1, 2025 estimate | 2026-11-17 |
| OMB metropolitan delineations | which metro area each hub county is in; city names for hub lookup | July 2023 (OMB Bulletin 23-01) | 2026-11-17 |
| National Weather Service (api.weather.gov) | active alerts at the hub | live at question time | never stored |

The date shown as "data as of" is the date the FEMA snapshot was fetched, not the period the data describes. NWS alerts never change a score: an investment review is a multi-year decision.

## 2. Typical year: expected disruption days

The headline number answers one question: in an average year, how many operating days does weather cost this hub? It is built per hazard family (winter, flood, hurricane, severe storm) from two signals, then summed.

### 2.1 Modeled days from FEMA

FEMA counts how many events of each sub-hazard hit the county per year. Each event is assumed to cost a fixed number of operating days. For a sub-hazard $k$ with annual frequency $\lambda_k$, adjustment factor $a_k$ (below) and days per event $d_k$, the modeled days are:

$$
m_k = \lambda_k \, a_k \, d_k
$$

| Family | Sub-hazard | Days per event $d_k$ |
|---|---|---|
| Winter | winter weather | 0.5 |
| Winter | ice storm | 2 |
| Winter | cold wave | 1 |
| Flood | inland flood | 2 |
| Flood | coastal flood | 2 |
| Hurricane | hurricane | 10 |
| Severe storm | tornado | 0.5 |
| Severe storm | strong wind | 0.25 |
| Severe storm | hail | 0.25 |

These are stated assumptions, not fitted values: no downtime records exist for these hubs. Most FEMA winter-weather events are advisory level and slow a hub rather than close it, hence 0.5 days. Sanity checks against real closures: Hurricane Harvey closed the Houston port and many distribution centres for 3-5 days; Hurricane Matthew's closures averaged about 17.5 days in the sources reviewed; the February 2021 Texas freeze stopped most freight for about 4 days. A missing FEMA value means the hazard does not occur in that county and counts as 0.

**Large counties.** FEMA counts events anywhere in the county. For local hazards (inland flood, tornado, strong wind, hail) only the events near the hub matter, so the count is scaled to a 1,000 sq mi area around the hub (about an 18-mile radius). Small counties are never scaled up, because a hub is also hit by events just outside its county line.

$$
a_k = \min\!\left(1, \frac{1000}{\text{county area in sq mi}}\right) \quad \text{for inland flood, tornado, strong wind, hail}
$$

**Coastal flood.** A hub is not on the waterfront by default, so the coastal-flood count is scaled by the share of the county that FEMA marks as exposed to coastal flooding. If FEMA has a frequency but no exposed area, the median share of the hubs with data (4.05%) is used, with a note.

$$
a_{\text{coastal}} = \min\!\left(1, \frac{\text{coastal-flood exposed area}}{\text{county area}}\right)
$$

For every other sub-hazard $a_k = 1$.

### 2.2 Observed days at the hub

The second signal is what actually happened at the hub point over the last 11 years. A day counts as a disruption day for a family when the daily weather crosses that family's threshold. A day can count for two families, but only once per family.

| Family | Observed disruption day |
|---|---|
| Winter | snowfall ≥ 5 cm, or minimum temperature ≤ −18 °C (0 °F) |
| Flood | precipitation ≥ 50 mm |
| Severe storm | maximum wind gust ≥ 75 km/h |
| Hurricane | not observable in daily grid data: no observed signal |

The count is turned into days per year using the real length of the window, $N$ days, so a window that is not calendar-aligned is not under- or overstated:

$$
o_f = \frac{\text{disruption days of family } f \text{ in the window}}{N / 365.25}
$$

### 2.3 Blend and total

Each family blends the long-term modeled view (weight 0.6) with the recent observed view (weight 0.4). Hurricane has no observed signal, so its modeled days count in full.

$$
D_f = 0.6 \sum_{k \in f} m_k + 0.4\, o_f \qquad D_{\text{hurricane}} = m_{\text{hurricane}}
$$

The typical-year total is the sum of the four families:

$$
D = D_{\text{winter}} + D_{\text{flood}} + D_{\text{hurricane}} + D_{\text{severe storm}}
$$

### 2.4 Exposure score and levels

The exposure score puts the total on a 0-100 scale with a fixed cap of 25 days per year. The cap is fixed, not relative to the other hubs, so adding or removing a hub never changes another hub's score.

$$
E = 100 \cdot \min\!\left(\frac{D}{25},\, 1\right)
$$

Each family score uses the same formula on $D_f$. The levels are:

| Level | Exposure score | Same thing in days per year |
|---|---|---|
| low | below 35 | below 8.75 |
| medium | 35 to below 60 | 8.75 to below 15 |
| high | 60 or more | 15 or more |

A single hazard family has its own levels by days per year: medium from 2 days, high from 5 days. The hurricane family is the exception and is levelled by its 10-year chance (section 3).

## 3. Hurricane: chance in 10 years

A hurricane is rare but severe: an average of 1-3 days a year hides an event that can close a hub for weeks. So the hurricane family is described by the chance of at least one hurricane-class event reaching the county within 10 years. Events are treated as arriving at random (a Poisson process) at the FEMA frequency $f$ per year:

$$
P_{10} = \left(1 - e^{-10 f}\right) \times 100\%
$$

Ten years is roughly the horizon of a facility investment or a warehouse lease: the question an analyst asks is "will this site be hit while we own it?". The hurricane level is medium from 20% and high from 50%. FEMA's hurricane frequency likely includes tropical storms, so read $P_{10}$ as "a hurricane-class storm reaches the county", not landfall.

## 4. Bad year: the worst 1 in 20 years

Expected days describe an average year; an investment must also survive a bad one. The bad-year number is the **average lost days in the worst 1 in 20 years** (tail value at risk at 95%, TVaR95). It is computed exactly, with no approximation and no randomness.

### 4.1 Annual lost days as random events

Each source of disruption is a stream of independent events arriving at random (a compound Poisson process). Every FEMA sub-hazard is a stream with rate $r_k = w\,\lambda_k\,a_k$ (the same weight $w$ = 0.6, or 1.0 for hurricane, and the same adjustments as section 2), each event losing $d_k$ days. The observed signal is a stream of 1-day events at rate $0.4\,o_f$. A year's lost days $S$ is the sum over all streams of (number of events × days per event). Its mean equals the typical-year total $D$, apart from the hurricane mix below.

### 4.2 Hurricane closure mix

Hurricane closures vary a lot: most are short, a few are very long. In the bad-year model, 80% of hurricane events close the hub about 4 days and 20% about 35 days. So the hurricane stream splits into two streams, at rates $0.8\,r_{\text{hurricane}}$ (4 days each) and $0.2\,r_{\text{hurricane}}$ (35 days each). The mix mean is $0.8 \times 4 + 0.2 \times 35 = 10.2$ days, against the 10 days per event used for expected days; the 0.2-day difference (0.06 days a year for Miami) is left in so the two lenses stay readable side by side.

### 4.3 The full distribution: Panjer recursion

All event sizes are multiples of a common step $h$ (0.25 days with the current table: the largest common divisor of the sizes). Write each size as $j\,h$ and let $\rho_j$ be the total rate of events of size $j\,h$, and $\Lambda = \sum_j \rho_j$. The probability $p(x)$ that a year loses exactly $x\,h$ days follows from the Panjer recursion for a compound Poisson sum:

$$
p(0) = e^{-\Lambda}, \qquad p(x) = \frac{1}{x} \sum_{j \le x} j\,\rho_j\, p(x - j) \quad (x = 1, 2, \dots)
$$

The recursion runs until the remaining probability is below $10^{-13}$, well past the tail.

### 4.4 TVaR95, with the atom split

Let $F$ be the cumulative distribution and $v$ the 95% quantile: the smallest $x$ with $F(x) \ge 0.95$. Because $S$ is discrete, the quantile point $v$ carries a probability "atom" $p(v)$ that straddles the 95% line. Only the part above the line belongs to the worst 5% of years, so it is split:

$$
\theta = \frac{F(v) - 0.95}{p(v)}
$$

$$
\operatorname{TVaR}_{95} = \frac{h}{0.05}\left[\, \sum_{x > v} x\, p(x) \;+\; \theta\, v\, p(v) \right]
$$

This is exactly the mean of the worst 5% of years. A seeded Monte Carlo check with 200,000 simulated years agreed to 0.01 days (Miami 42.79, Minneapolis 38.75).

### 4.5 Which family drives the bad year: Euler allocation

Each family's share of the bad-year days is its expected contribution in the worst 5% of years, $E[S_f \mid \text{worst 5\%}]$. For a compound Poisson sum this is exact and comes from the same recursion: the expected days of family $f$ in years with total exactly $x$ steps is

$$
e_f(x) = \sum_{j} j\,\rho_{f,j}\; p(x - j)
$$

where $\rho_{f,j}$ is the rate of family $f$'s events of size $j\,h$. Then

$$
B_f = \frac{h}{0.05}\left[\, \sum_{x > v} e_f(x) \;+\; \theta\, e_f(v) \right], \qquad \sum_f B_f = \operatorname{TVaR}_{95}
$$

The bad-year excess of a family is $B_f - D_f$. The bad year has no level (low, medium, high): on the day cut-offs almost every hub would read high.

## 5. Review priority

Review priority ranks which hubs to examine first. It starts from weather exposure and lets two things amplify it: how many people the hub serves, and how slowly its county recovers.

$$
P = E \times \left(0.6 + 0.25\, s + 0.15\, g\right)
$$

**People share** $s$ uses the metro-area population on a log scale between 0.5 million and 25 million, so each doubling of the metro counts the same. A hub serves part of its metro, so ten times the people should not mean ten times the priority. The 25 million upper end sits above the largest hub metro (New York, 20.1 million), so no hub is clipped.

$$
s = \min\!\left(1,\ \max\!\left(0,\ \frac{\log_{10}(\text{population} / 0.5\text{M})}{\log_{10}(25\text{M} / 0.5\text{M})}\right)\right)
$$

**Recovery gap** $g$ comes from FEMA's community resilience score (0-100, higher is more resilient). Low resilience means disruption hurts more and recovery is slower.

$$
g = \frac{100 - \text{resilience score}}{100}
$$

**Why multiplicative.** The multiplier runs from 0.6 to 1.0, so people and resilience can raise a hub's priority but cannot create priority where there is little weather. Under an earlier additive version, Los Angeles ranked 6th with low exposure; now it ranks 14th. The breakdown shows three contributions that add up to $P$: the base $0.6\,E$, the people uplift $0.25\,s\,E$ and the recovery uplift $0.15\,g\,E$.

Priority uses the same levels as exposure (low below 35, high from 60). Because $P \le E$, priority levels run lower than exposure levels by construction. Priority reflects the typical year only; the bad-year days are shown alongside it, not folded into it.

## 6. People served and people-days

**People served** is the population of the hub's OMB metro area (Census Vintage 2025). It is a proxy for demand near a regional hub: a hub serves part of its metro and places beyond it, and national or air-cargo hubs serve far beyond their metro. In production the hub's own shipment volume per region would replace it.

**People-days** read the typical year as a service measure: if the hub is disrupted, the people it serves times the days lost. It is not a count of people harmed by the weather. Population enters linearly here (twice the people disrupted is twice the people-days), unlike the bounded log amplifier in priority.

$$
\text{people-days (millions)} = \frac{\text{people served} \times D}{10^{6}}, \qquad \text{bad-year people-days} = \frac{\text{people served} \times \operatorname{TVaR}_{95}}{10^{6}}
$$

## 7. Worked example: Miami and Minneapolis

Every number below was printed by the scoring code on the committed snapshot (2026-11-17). Intermediate values are shown to 3-4 decimals; the app shows one decimal.

### 7.1 Miami (Miami-Dade County, 2,413.4 sq mi)

**Modeled and observed signals.** Area factor for local hazards $= 1000 / 2413.4 = 0.414$. Coastal exposed share $= 5.6\%$.

| Family | Signal | Raw | Adjusted days $m_k$ or $o_f$ | Weight | Contribution (days/yr) |
|---|---|---|---|---|---|
| Winter | winter weather | 0.0 events/yr | 0.0 | 0.6 | 0.0 |
| Winter | ice storm | missing (0) | 0.0 | 0.6 | 0.0 |
| Winter | cold wave | 1.284 events/yr | $1.284 \times 1 = 1.284$ | 0.6 | 0.770 |
| Winter | observed (snow ≥ 5 cm or ≤ −18 °C) | 0.0 days/yr | 0.0 | 0.4 | 0.0 |
| Flood | inland flood | 4.0 events/yr | $4.0 \times 0.414 \times 2 = 3.315$ | 0.6 | 1.989 |
| Flood | coastal flood | 2.25 events/yr | $2.25 \times 0.056 \times 2 = 0.251$ | 0.6 | 0.150 |
| Flood | observed (≥ 50 mm) | 2.454 days/yr | 2.454 | 0.4 | 0.982 |
| Hurricane | hurricane | 0.305 events/yr | $0.305 \times 10 = 3.050$ | 1.0 | 3.050 |
| Severe storm | tornado | 1.074 events/yr | $1.074 \times 0.414 \times 0.5 = 0.222$ | 0.6 | 0.133 |
| Severe storm | strong wind | 0.758 events/yr | $0.758 \times 0.414 \times 0.25 = 0.079$ | 0.6 | 0.047 |
| Severe storm | hail | 0.559 events/yr | $0.559 \times 0.414 \times 0.25 = 0.058$ | 0.6 | 0.035 |
| Severe storm | observed (gust ≥ 75 km/h) | 1.636 days/yr | 1.636 | 0.4 | 0.655 |

**Typical year.** $D_{\text{winter}} = 0.770$, $D_{\text{flood}} = 3.121$, $D_{\text{hurricane}} = 3.050$, $D_{\text{severe}} = 0.870$, so $D = 7.811$ days per year.

$$
E = 100 \cdot \min(7.811 / 25,\ 1) = 31.24 \;\Rightarrow\; 31.2 \text{ (low)}
$$

Family levels: winter 0.8 days (low), flood 3.1 days (medium), severe storm 0.9 days (low). Top driver: flood.

**Hurricane chance in 10 years.**

$$
P_{10} = 1 - e^{-10 \times 0.30497} = 1 - e^{-3.0497} = 95.3\% \;\Rightarrow\; \text{high}
$$

**Bad year.** Event streams (days per event, events per year): winter (1, 0.770); flood (2, 0.994), (2, 0.075), observed (1, 0.982); hurricane (4, 0.244), (35, 0.061); severe storm (0.5, 0.267), (0.25, 0.189), (0.25, 0.139), observed (1, 0.655). Grid step $h = 0.25$ days, total rate $\Lambda = 4.375$ events per year, distribution mean 7.872 days (7.811 plus the hurricane mix's 0.061). The 95% quantile is $v = 37.5$ days with $F(v^-) = 0.94959$, $F(v) = 0.95058$, atom $p(v) = 0.00099$, so $\theta = 0.586$.

$$
\operatorname{TVaR}_{95} = 42.79 \text{ days} \;\Rightarrow\; 42.8
$$

Family shares $B_f$: hurricane 37.4, flood 3.6, severe storm 0.9, winter 0.8 (they add up to 42.8 within rounding). Almost all of the 35.0-day excess is hurricane: in Miami's worst years a long hurricane closure has happened. That is why Miami ranks 13th in a typical year and 1st in a bad year.

**Review priority.** Metro population 6,391,072 (Miami-Fort Lauderdale-West Palm Beach). Resilience score 42.907.

$$
s = \frac{\log_{10}(6.391 / 0.5)}{\log_{10}(50)} = 0.6513, \qquad g = \frac{100 - 42.907}{100} = 0.5709
$$

$$
P = 31.243 \times (0.6 + 0.25 \times 0.6513 + 0.15 \times 0.5709) = 31.243 \times 0.8485 = 26.51 \;\Rightarrow\; 26.5 \text{ (low)}
$$

Breakdown: base $0.6 \times 31.24 = 18.75$, people uplift 5.09, recovery uplift 2.68.

**People-days.** $6{,}391{,}072 \times 7.811 / 10^6 = 49.9$ million a year; bad year $6{,}391{,}072 \times 42.79 / 10^6 = 273.5$ million.

### 7.2 Minneapolis (Hennepin County, 612.9 sq mi)

The county is smaller than 1,000 sq mi, so no area scaling. No coastal flood and no hurricanes in FEMA (missing, counted as 0).

| Family | Signal | Raw | Adjusted days $m_k$ or $o_f$ | Weight | Contribution (days/yr) |
|---|---|---|---|---|---|
| Winter | winter weather | 16.579 events/yr | $16.579 \times 0.5 = 8.289$ | 0.6 | 4.974 |
| Winter | ice storm | 0.485 events/yr | $0.485 \times 2 = 0.971$ | 0.6 | 0.582 |
| Winter | cold wave | 8.947 events/yr | $8.947 \times 1 = 8.947$ | 0.6 | 5.368 |
| Winter | observed (snow ≥ 5 cm or ≤ −18 °C) | 30.271 days/yr | 30.271 | 0.4 | 12.108 |
| Flood | inland flood | 1.536 events/yr | $1.536 \times 2 = 3.071$ | 0.6 | 1.843 |
| Flood | coastal flood | missing (0) | 0.0 | 0.6 | 0.0 |
| Flood | observed (≥ 50 mm) | 1.091 days/yr | 1.091 | 0.4 | 0.436 |
| Hurricane | hurricane | missing (0) | 0.0 | 1.0 | 0.0 |
| Severe storm | tornado | 0.458 events/yr | $0.458 \times 0.5 = 0.229$ | 0.6 | 0.137 |
| Severe storm | strong wind | 4.566 events/yr | $4.566 \times 0.25 = 1.142$ | 0.6 | 0.685 |
| Severe storm | hail | 6.412 events/yr | $6.412 \times 0.25 = 1.603$ | 0.6 | 0.962 |
| Severe storm | observed (gust ≥ 75 km/h) | 1.182 days/yr | 1.182 | 0.4 | 0.473 |

**Typical year.** $D_{\text{winter}} = 23.033$, $D_{\text{flood}} = 2.279$, $D_{\text{hurricane}} = 0$, $D_{\text{severe}} = 2.257$, so $D = 27.569$ days per year.

$$
E = 100 \cdot \min(27.569 / 25,\ 1) = 100.0 \text{ (high)}
$$

Minneapolis is the only hub above the 25-day cap. Family levels: winter 23.0 days (high), flood 2.3 days (medium), severe storm 2.3 days (medium). Hurricane: $P_{10} = 0\%$ (low). Top driver: winter.

**Bad year.** Event streams: winter (0.5, 9.947), (2, 0.291), (1, 5.368), observed (1, 12.108); flood (2, 0.921), observed (1, 0.436); severe storm (0.5, 0.275), (0.25, 2.740), (0.25, 3.847), observed (1, 0.473). Grid step $h = 0.25$, $\Lambda = 36.41$ events per year, mean 27.569 days. The 95% quantile is $v = 36.25$ days with $F(v^-) = 0.94680$, $F(v) = 0.95138$, $p(v) = 0.00457$, so $\theta = 0.301$.

$$
\operatorname{TVaR}_{95} = 38.74 \text{ days} \;\Rightarrow\; 38.7
$$

Family shares $B_f$: winter 31.9, flood 4.2, severe storm 2.6 (sum 38.7). Many small, frequent events make Minneapolis's year predictable: its bad year is 11.2 days above its typical year, against 35.0 for Miami.

**Review priority.** Metro population 3,790,295 (Minneapolis-St. Paul-Bloomington). Resilience score 98.092.

$$
s = \frac{\log_{10}(3.790 / 0.5)}{\log_{10}(50)} = 0.5178, \qquad g = \frac{100 - 98.092}{100} = 0.0191
$$

$$
P = 100 \times (0.6 + 0.25 \times 0.5178 + 0.15 \times 0.0191) = 100 \times 0.7323 = 73.23 \;\Rightarrow\; 73.2 \text{ (high)}
$$

Breakdown: base 60.00, people uplift 12.94, recovery uplift 0.29.

**People-days.** $3{,}790{,}295 \times 27.569 / 10^6 = 104.5$ million a year; bad year $3{,}790{,}295 \times 38.74 / 10^6 = 146.8$ million.

## 8. Sensitivity and limitations

### 8.1 Sensitivity

`python -m app.sensitivity` changes one assumption at a time and compares the new ranking of all 15 hubs with the current one (Spearman rank correlation on unrounded values; 1.0 means the same order). Full results: [evals/results/sensitivity.md](../evals/results/sensitivity.md).

| What changes | Ranking tested | Lowest Spearman | Top hub |
|---|---|---|---|
| each days-per-event value halved and doubled | typical year | 0.961 (inland flood × 2) | never changes |
| FEMA / observed blend from 0.3 to 1.0 | typical year | 0.893 (FEMA 0.3 / observed 0.7) | never changes |
| large-county reference area 500 or 2,000 sq mi | typical year | 0.961 (500 sq mi) | never changes |
| hurricane mix 70/30 and 90/10, long closure 20 or 50 days | bad year | 0.925 (long closure 20 days) | changes |
| people term linear, log cap 10M or 40M, or none | review priority | 0.971 (no people term) | never changes |

The typical-year ranking and the review priority are robust to any single assumption within a factor of two. The bad-year top 4 (Miami, Minneapolis, Houston, Newark) is not: for the coastal hubs the yearly chance of a long hurricane closure sits near 5%, exactly where TVaR95 looks, so their order rests on the assumed closure mix.

### 8.2 Limitations (documented, not fixed)

- **Days per event are assumptions**, not fitted to loss data. They should be fitted to the company's downtime logs in production.
- **The hurricane closure mix (80% × 4 days, 20% × 35 days) is assumed**, and the bad-year order of the coastal hubs depends on it.
- **FEMA hurricane frequency likely includes tropical storms**, so the 10-year chances (Newark 65.7%, Chicago 8.9%, Phoenix 10.9%) read as "a hurricane-class storm reaches the county". The medium hurricane level of Memphis (21.0%) and Atlanta (31.6%), far inland, most likely reflects tropical-storm remnants.
- **Coastal flood overlaps hurricane storm surge:** the same storm can count under both. With the exposed-area share the double count is small (coastal flood is 0.15 of Miami's 3.1 flood days).
- **Missing exposed coastal area** falls back to a 4.05% share (median of the six hubs with data); no hub needs it on the current snapshot.
- **The hub's site inside its county is unknown:** it could be inside or outside the flood zone.
- **Artefacts:** FEMA's cold-wave count is relative to local normals (Miami 1.28 cold waves a year); Los Angeles County includes mountains, so winter weather (6.59 events a year) gives LA a winter top driver it does not have at sea level, and this carries into its people-days.
- **Area scaling for tornado, wind and hail may double-adjust:** FEMA already models these on a grid of roughly 930 sq mi.
- **Level edges are hard cut-offs:** Newark's 15.02 expected days put it just inside high exposure (15 days); Chicago's review priority 59.99 displays as 60.0 and reads high. The score-change alerts use a 2-point margin for this reason.
- **The bad-year model assumes independent random events:** real winters cluster (a cold season brings several storms), so the bad-year days of winter hubs are likely understated.
- **People served is a metro-population proxy** for demand near a regional hub; national or air-cargo hubs (Memphis- or Louisville-style) serve far beyond their metro. Resilience stays county-level.
- **Three geographies meet in one score:** hazards come from the county (FEMA) and the hub point (Open-Meteo), people from the metro area, resilience from the county.
- **No climate trend:** 2015-2025 rates are treated as stationary. FEMA data is county-level and modeled; Open-Meteo is reanalysis grid data (about 25 km), not station observations.
