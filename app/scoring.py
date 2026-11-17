"""Deterministic scoring over the committed snapshot (spec section 6, formula v2).

Exposure is expected disruption days per year (typical year):
- modeled days = FEMA NRI events per year x days lost per event (local hazards scaled down for large
  counties, coastal flood scaled by the share of county area exposed)
- observed days = days per year at the hub point over a disruption threshold (Open-Meteo, 2015-2025)
- each family blends the two (NRI 0.6, observed 0.4; hurricane NRI only), families add up,
  and the index is min(days / 25, 1) x 100, so the 35/60 bands mean 8.75 and 15 days per year.
Family bands: 2 / 5 days per year; hurricane by the chance of at least one event in 10 years (20% / 50%).
Bad-year lens: average lost days in the worst 1 in 20 years (TVaR95), computed exactly from the compound-Poisson
distribution of annual days (Panjer recursion), with an exact per-family allocation.
Priority = exposure x (0.6 + 0.25 x people served share + 0.15 x resilience-gap share).
Same snapshot and config always give the same output; ties break by hub_id.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from fractions import Fraction
from datetime import date
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict

from app.data import DATA_DIR, OPEN_METEO_URL
from app.schemas import (
    Band, BandThresholds, Family, FamilyScore, Hazard, Hub, HubHistory, HubScore, Metric, MonthDays, PerMillionHub,
    RankedHub, Ranking, Region, ScoreKind, ScoreRow, Signal, WeatherStat, WhatIfInput, WhatIfResult, YearDays,
)

__all__ = [
    "DATA_DIR", "DEFAULT_CONFIG", "DataUnavailable", "FAMILIES", "ScoringConfig", "Snapshot",
    "UPGRADE_CATEGORIES", "band", "load_hubs", "load_snapshot", "normalize", "rank", "score_all",
    "score_rows", "weather_stat", "what_if", "hub_history", "disruption_rules",
]

FAMILIES: tuple[Family, ...] = ("winter", "flood", "hurricane", "severe_storm")

NRI_SOURCE = "FEMA National Risk Index, annualized frequency (county)"
OBS_SOURCE = "Open-Meteo Historical Weather API (ERA5 reanalysis), hub point"

# NRI sub-hazards per family: (field prefix, label)
NRI_HAZARDS: dict[Family, list[tuple[str, str]]] = {
    "winter": [("WNTW", "winter weather"), ("ISTM", "ice storm"), ("CWAV", "cold wave")],
    "flood": [("IFLD", "inland flood"), ("CFLD", "coastal flood")],
    "hurricane": [("HRCN", "hurricane")],
    "severe_storm": [("TRND", "tornado"), ("SWND", "strong wind"), ("HAIL", "hail")],
}

UPGRADE_CATEGORIES: dict[Family, list[str]] = {
    "winter": ["winterized fleet", "snow and ice removal", "heated docks"],
    "flood": ["drainage", "raised docks", "flood barriers"],
    "hurricane": ["wind-rated roofing", "backup generators", "pre-positioned inventory"],
    "severe_storm": ["roof and hail hardening", "covered loading", "backup power"],
}


class DataUnavailable(Exception):
    """The snapshot has no data for the requested hub, metric or year."""


class ScoringConfig(BaseModel):
    """Every weight, cap and threshold. Values set by Eden in the weights session (spec section 6)."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    # days lost per counted NRI event
    days_per_event: dict[str, float] = {
        "HRCN": 10, "ISTM": 2, "IFLD": 2, "CFLD": 2, "WNTW": 0.5,
        "CWAV": 1, "TRND": 0.5, "SWND": 0.25, "HAIL": 0.25,
    }
    # local hazards: county counts scaled by min(1, reference_area / county area)
    local_hazards: tuple[str, ...] = ("IFLD", "TRND", "SWND", "HAIL")
    reference_area_sq_mi: float = 1000.0
    # coastal flood: county counts scaled by the share of county area NRI marks as exposed (CFLD_EXP_AREA / AREA)
    coastal_exposure_scaling: bool = True
    # used when NRI has a coastal-flood frequency but no exposed area: median share of the hubs with data
    # (Detroit 1.7%, LA 2.5%, Chicago 2.9%, Newark 5.2%, Miami 5.6%, Houston 9.2%)
    coastal_default_exposed_share: float = 0.0405

    nri_weight: float = 0.6
    observed_weight: float = 0.4
    observed_start: str = "2015-01-01"  # full snapshot: 11 years
    observed_end: str = "2025-12-31"
    snow_cm: float = 5.0  # winter disruption day: snowfall >= 5 cm or min temp <= -18 C
    cold_c: float = -18.0
    heavy_rain_mm: float = 50.0  # flood disruption day
    gust_kmh: float = 75.0  # severe-storm disruption day

    exposure_days_cap: float = 25.0  # index = min(days / cap, 1) x 100

    priority_exposure_weight: float = 0.6
    priority_people_weight: float = 0.25
    priority_resilience_weight: float = 0.15
    population_cap: float = 5_000_000

    medium_from: float = 35.0
    high_from: float = 60.0
    # family bands: by days per year; hurricane by chance of at least one event in 10 years
    family_medium_from_days: float = 2.0
    family_high_from_days: float = 5.0
    hurricane_medium_from_pct: float = 20.0
    hurricane_high_from_pct: float = 50.0
    hurricane_window_years: float = 10.0

    # bad-year lens: TVaR at 95% = average lost days in the worst 1 in 20 years
    bad_year_alpha: float = 0.95
    # hurricane closure-length mix in the bad-year distribution: 80% short (4 days), 20% severe (35 days).
    # Its mean (10.2 days) is close to the 10 days per event used for expected days.
    hurricane_days_mix: tuple[tuple[float, float], ...] = ((0.8, 4.0), (0.2, 35.0))

    # what-if baseline: a disruption day counts the same in every family
    default_family_weights: dict[str, float] = {"winter": 0.25, "flood": 0.25, "hurricane": 0.25, "severe_storm": 0.25}


DEFAULT_CONFIG = ScoringConfig()


@dataclass(frozen=True)
class Snapshot:
    nri: dict[str, Any]
    weather: dict[str, Any]

    @property
    def data_as_of(self) -> str:
        return self.nri["fetched_at"][:10]


def load_hubs(path: Path = DATA_DIR / "hubs.json") -> list[Hub]:
    return [Hub(**h) for h in json.loads(Path(path).read_text())]


def load_snapshot(dir: Path = DATA_DIR / "snapshot") -> Snapshot:
    dir = Path(dir)
    return Snapshot(
        nri=json.loads((dir / "nri.json").read_text()),
        weather=json.loads((dir / "weather.json").read_text()),
    )


# ---------- helpers ----------


def normalize(raw: float, cap: float) -> float:
    return min(max(raw, 0.0) / cap, 1.0) * 100


def band(value: float, config: ScoringConfig = DEFAULT_CONFIG) -> Band:
    if value >= config.high_from:
        return "high"
    if value >= config.medium_from:
        return "medium"
    return "low"


def family_band(days: float, config: ScoringConfig = DEFAULT_CONFIG) -> Band:
    if days >= config.family_high_from_days:
        return "high"
    if days >= config.family_medium_from_days:
        return "medium"
    return "low"


def hurricane_band(probability_pct: float, config: ScoringConfig = DEFAULT_CONFIG) -> Band:
    if probability_pct >= config.hurricane_high_from_pct:
        return "high"
    if probability_pct >= config.hurricane_medium_from_pct:
        return "medium"
    return "low"


def hurricane_probability_pct(frequency: float, config: ScoringConfig = DEFAULT_CONFIG) -> float:
    """Chance of at least one event in the window, Poisson: (1 - e^(-years x frequency)) x 100."""
    return (1 - math.exp(-config.hurricane_window_years * max(frequency, 0.0))) * 100


def _thresholds(config: ScoringConfig) -> BandThresholds:
    cap = config.exposure_days_cap
    return BandThresholds(
        medium_from=config.medium_from, high_from=config.high_from, days_cap=cap,
        medium_from_days=_r(config.medium_from / 100 * cap, 2), high_from_days=_r(config.high_from / 100 * cap, 2),
        family_medium_from_days=config.family_medium_from_days, family_high_from_days=config.family_high_from_days,
        hurricane_medium_from_pct=config.hurricane_medium_from_pct,
        hurricane_high_from_pct=config.hurricane_high_from_pct,
    )


def _r(x: float, nd: int) -> float:
    return round(x + 0.0, nd)


FAMILY_VARS = {
    "winter": ("snowfall_sum", "temperature_2m_min"),
    "flood": ("precipitation_sum",),
    "severe_storm": ("wind_gusts_10m_max",),
}


def _observed_days(series: dict[str, list], config: ScoringConfig) -> tuple[dict[str, float], dict[str, int]]:
    """Disruption days per year in the scoring window, per family, and null values seen per family.

    Per year = event days / (days in the window / 365.25), so a window that is not calendar-aligned
    (e.g. a rolling 36 months) is not divided by the number of calendar years it touches.
    """
    idx = [i for i, t in enumerate(series["time"]) if config.observed_start <= t <= config.observed_end]
    years = len(idx) / 365.25 or 1.0
    nulls = {f: sum(1 for v in vars_ for i in idx if series[v][i] is None) for f, vars_ in FAMILY_VARS.items()}
    counts = {f: 0 for f in FAMILY_VARS}
    for i in idx:
        for f, hit in _disruption_day(series, i, config).items():
            counts[f] += hit
    return {f: counts[f] / years for f in FAMILY_VARS}, nulls


def _disruption_day(series: dict[str, list], i: int, config: ScoringConfig) -> dict[str, bool]:
    """The observed disruption-day rules, the one place they live (KPI signal and hub history both use them).

    A day can count for several families, but at most once per family.
    """
    snow, tmin = series["snowfall_sum"][i], series["temperature_2m_min"][i]
    rain, gust = series["precipitation_sum"][i], series["wind_gusts_10m_max"][i]
    return {
        "winter": (snow or 0) >= config.snow_cm or (tmin is not None and tmin <= config.cold_c),
        "flood": (rain or 0) >= config.heavy_rain_mm,
        "severe_storm": (gust or 0) >= config.gust_kmh,
    }


def disruption_rules(config: ScoringConfig = DEFAULT_CONFIG) -> dict[str, str]:
    """Plain-language observed disruption-day rule per family, from the same config values."""
    return {
        "winter": f"snow >= {config.snow_cm:g} cm or min temp <= {config.cold_c:g} °C",
        "flood": f"precipitation >= {config.heavy_rain_mm:g} mm",
        "severe_storm": f"max gust >= {config.gust_kmh:g} km/h",
        "hurricane": "not observable in daily weather data (see the hurricane 10-year probability)",
    }


OBS_LABELS = {
    "winter": "observed winter disruption days (snow >= {snow_cm:g} cm or min temp <= {cold_c:g} C)",
    "flood": "observed heavy-rain days (precipitation >= {heavy_rain_mm:g} mm)",
    "severe_storm": "observed high-gust days (gust >= {gust_kmh:g} km/h)",
}


Stream = tuple[float, float]  # (days lost per event, events per year)


def _fgcd(a: Fraction, b: Fraction) -> Fraction:
    return Fraction(math.gcd(a.numerator * b.denominator, b.numerator * a.denominator), a.denominator * b.denominator)


def tvar95(streams: dict[str, list[Stream]], alpha: float = 0.95) -> tuple[float, dict[str, float]]:
    """TVaR (mean of the worst 1 - alpha of years) of annual lost days, and each family's exact share of it.

    Annual days S = sum of independent compound-Poisson streams (events at a rate, each losing a fixed number of
    days). The distribution of S is computed exactly on a grid whose step is the largest common divisor of the
    event sizes (Panjer recursion), with no randomness. The atom at the 95% quantile is split so the tail holds
    exactly 1 - alpha of probability. Family shares are the Euler allocation E[S_family | worst years], computed
    with E[S_f; S=x] = sum over f's streams of size x rate x P(S = x - size); they sum to the TVaR.
    """
    shares = {f: 0.0 for f in streams}
    active = [(f, Fraction(d).limit_denominator(64), r) for f, lst in streams.items() for d, r in lst if d > 0 and r > 0]
    if not active:
        return 0.0, shares
    unit = active[0][1]
    for _, d, _ in active[1:]:
        unit = _fgcd(unit, d)
    by_family: dict[str, list[tuple[int, float]]] = {}
    for f, d, r in active:
        j = int(d / unit)
        by_family.setdefault(f, []).append((j, r * j))  # (size in grid units, rate x size)
    lam = sum(r for _, _, r in active)
    if lam > 700:
        raise ValueError(f"event rate {lam:.0f} per year is too high for the recursion")
    mean = sum(rj for lst in by_family.values() for _, rj in lst)
    sd = math.sqrt(sum(rj * j for lst in by_family.values() for j, rj in lst))
    max_j = max(j for lst in by_family.values() for j, _ in lst)
    horizon = int(mean + 15 * sd + 3 * max_j) + 1
    g = [math.exp(-lam)]
    h = {f: [0.0] for f in by_family}
    cum = g[0]
    x = 0
    while (x < horizon or 1 - cum > 1e-13) and x < 400_000:
        x += 1
        total = 0.0
        for f, lst in by_family.items():
            hf = sum(rj * g[x - j] for j, rj in lst if j <= x)
            h[f].append(hf)
            total += hf
        g.append(total / x)
        cum += g[-1]
    cum, v = 0.0, 0
    for v, p in enumerate(g):
        cum += p
        if cum >= alpha - 1e-15:
            break
    split = (cum - alpha) / g[v] if g[v] > 0 else 0.0  # share of the quantile atom that belongs to the tail
    scale = float(unit) / (1 - alpha)
    tail = sum(i * g[i] for i in range(v + 1, len(g))) + split * v * g[v]
    for f in by_family:
        shares[f] = (sum(h[f][v + 1:]) + split * h[f][v]) * scale
    return tail * scale, shares


def _family_days(
    hub: Hub, snapshot: Snapshot, config: ScoringConfig,
) -> dict[Family, tuple[float, list[Signal], list[Stream]]]:
    """Per family: expected days per year, signals, and the event streams of the bad-year distribution.

    Streams: each NRI sub-hazard at rate weight x adjusted frequency, losing its days per event (hurricane: the
    closure-length mix); the observed signal as 1-day events at rate observed weight x observed days per year.
    """
    county = snapshot.nri["counties"][hub.county_fips]
    observed, nulls = _observed_days(snapshot.weather["hubs"][hub.id], config)
    area = county.get("AREA") or 0
    out: dict[Family, tuple[float, list[Signal], float]] = {}
    for family in FAMILIES:
        nri_w = 1.0 if family == "hurricane" else config.nri_weight
        signals: list[Signal] = []
        days = 0.0
        streams: list[Stream] = []
        for key, label in NRI_HAZARDS[family]:
            raw = county.get(f"{key}_AFREQ")
            dpe = config.days_per_event[key]
            note = None
            factor = 1.0
            if raw is None:
                note = "missing in NRI"
            elif key in config.local_hazards and area > config.reference_area_sq_mi:
                factor = config.reference_area_sq_mi / area
                note = f"area-adjusted x{factor:.2f} (county {area:,.0f} sq mi)"
            elif key == "CFLD" and config.coastal_exposure_scaling:
                exposed = county.get("CFLD_EXP_AREA")
                if exposed is None or not area:
                    factor = config.coastal_default_exposed_share
                    note = (f"exposed coastal area missing in NRI; default share {100 * factor:.2f}% "
                            "(median of the hubs with data)")
                else:
                    factor = min(exposed / area, 1.0)
                    note = f"{100 * factor:.1f}% of county area exposed to coastal flooding (NRI)"
            implied = (raw or 0.0) * dpe * factor
            contribution = nri_w * implied
            days += contribution
            rate = nri_w * (raw or 0.0) * factor
            if key == "HRCN":
                streams += [(d, share * rate) for share, d in config.hurricane_days_mix]
            else:
                streams.append((dpe, rate))
            signals.append(Signal(
                name=f"{label} (FEMA NRI, {dpe:g} days/event)", source=NRI_SOURCE,
                raw=None if raw is None else _r(raw, 3), unit="events/year", cap=None,
                normalized=_r(implied, 3), weight=nri_w, contribution=_r(contribution, 3), note=note,
            ))
        if family != "hurricane":
            obs = observed[family]
            contribution = config.observed_weight * obs
            days += contribution
            streams.append((1.0, contribution))  # observed disruption days as 1-day events
            signals.append(Signal(
                name=OBS_LABELS[family].format(**config.model_dump()), source=OBS_SOURCE,
                raw=_r(obs, 3), unit="days/year", cap=None, normalized=_r(obs, 3),
                weight=config.observed_weight, contribution=_r(contribution, 3),
                note=(f"average per year {config.observed_start} to {config.observed_end}; "
                      f"{nulls[family]} null values"),
            ))
        out[family] = (days, signals, streams)
    return out


def _priority(exposure: float, county: dict, config: ScoringConfig) -> tuple[float, list[Signal]]:
    """priority = exposure x (0.6 + 0.25 x people share + 0.15 x resilience-gap share), 0-100.

    Multiplicative: people served and low resilience amplify weather exposure; they cannot create
    priority where there is no exposure. Signal contributions add up to the priority.
    """
    pop = county.get("POPULATION")
    resl = county.get("RESL_SCORE")
    people = normalize(pop or 0, config.population_cap)  # 0-100
    gap = 100 - (resl or 0)  # 0-100
    parts = [
        ("overall exposure (base share)", "scoring", exposure, "score 0-100", None, exposure,
         config.priority_exposure_weight, config.priority_exposure_weight * exposure, None),
        ("people served (county population)", NRI_SOURCE.replace("annualized frequency", "population"),
         pop, "people", config.population_cap, people, config.priority_people_weight,
         exposure * config.priority_people_weight * people / 100,
         "missing in NRI" if pop is None else "multiplies exposure"),
        ("resilience gap (100 - FEMA community resilience score)",
         "FEMA National Risk Index, community resilience (county)", resl, "score 0-100", None, gap,
         config.priority_resilience_weight, exposure * config.priority_resilience_weight * gap / 100,
         "missing in NRI" if resl is None else "multiplies exposure"),
    ]
    total = 0.0
    signals = []
    for name, source, raw, unit, cap, normalized, weight, contribution, note in parts:
        total += contribution
        signals.append(Signal(
            name=name, source=source, raw=None if raw is None else _r(raw, 3), unit=unit, cap=cap,
            normalized=_r(normalized, 2), weight=weight, contribution=_r(contribution, 2), note=note,
        ))
    return total, signals


MAX_FAMILY_WEIGHT = 1e6


def _effective_weights(weights: dict[str, float] | None, config: ScoringConfig) -> dict[Family, float]:
    """Analyst weights over defaults, renormalized to sum 1."""
    for f, w in (weights or {}).items():
        if not math.isfinite(w) or w > MAX_FAMILY_WEIGHT:
            raise ValueError(f"family weight for {f} must be a finite number up to {MAX_FAMILY_WEIGHT:g}, got {w}")
    base = config.default_family_weights
    chosen = {f: (weights or {}).get(f) or base[f] for f in FAMILIES}
    total = sum(chosen.values())
    return {f: chosen[f] / total for f in FAMILIES}


def _multipliers(effective: dict[Family, float], config: ScoringConfig) -> dict[Family, float]:
    """How much one disruption day from each family counts relative to the default weights."""
    base = config.default_family_weights
    s_base = sum(base[f] for f in FAMILIES)
    return {f: effective[f] / (base[f] / s_base) for f in FAMILIES}


# ---------- public API ----------


def _score_hub(hub: Hub, snapshot: Snapshot, config: ScoringConfig) -> HubScore:
    fam = _family_days(hub, snapshot, config)
    total_days = sum(d for d, _, _ in fam.values())
    exposure = normalize(total_days, config.exposure_days_cap)
    county = snapshot.nri["counties"][hub.county_fips]
    priority, priority_signals = _priority(exposure, county, config)
    top = max(FAMILIES, key=lambda f: (fam[f][0], -FAMILIES.index(f)))
    shares = {f: 100 * (fam[f][0] / total_days if total_days else 1 / len(FAMILIES)) for f in FAMILIES}
    hurricane_pct = _r(hurricane_probability_pct(county.get("HRCN_AFREQ") or 0.0, config), 1)
    bad_year, bad_shares = tvar95({f: fam[f][2] for f in FAMILIES}, config.bad_year_alpha)
    families = {
        f: FamilyScore(family=f, score=_r(normalize(fam[f][0], config.exposure_days_cap), 1),
                       days_per_year=_r(fam[f][0], 1), bad_year_days=_r(bad_shares[f], 1),
                       # bands follow the displayed (rounded) values, like exposure_band
                       band=(hurricane_band(hurricane_pct, config) if f == "hurricane"
                             else family_band(_r(fam[f][0], 1), config)),
                       signals=fam[f][1])
        for f in FAMILIES
    }
    exposure_r, priority_r = _r(exposure, 1), _r(priority, 1)
    return HubScore(
        hub_id=hub.id,
        exposure=exposure_r,
        exposure_days_per_year=_r(total_days, 1),
        bad_year_days=_r(bad_year, 1),
        hurricane_10yr_probability_pct=_r(hurricane_pct, 1),
        exposure_band=band(exposure_r, config),
        families=families,
        family_weights={f: _r(shares[f], 1) for f in FAMILIES},
        priority=priority_r,
        priority_band=band(priority_r, config),
        priority_signals=priority_signals,
        top_driver=top,
        upgrade_categories=list(UPGRADE_CATEGORIES[top]),
        band_thresholds=_thresholds(config),
        data_as_of=snapshot.data_as_of,
    )


def expected_days(hub: Hub, snapshot: Snapshot, config: ScoringConfig = DEFAULT_CONFIG) -> float:
    """Unrounded expected disruption days per year (typical year)."""
    return sum(d for d, _, _ in _family_days(hub, snapshot, config).values())


def bad_year_days(hub: Hub, snapshot: Snapshot, config: ScoringConfig = DEFAULT_CONFIG) -> float:
    """Unrounded average lost days in the worst 1 in 20 years (TVaR95)."""
    fam = _family_days(hub, snapshot, config)
    return tvar95({f: fam[f][2] for f in FAMILIES}, config.bad_year_alpha)[0]


def score_all(hubs: list[Hub], snapshot: Snapshot, config: ScoringConfig = DEFAULT_CONFIG) -> dict[str, HubScore]:
    return {h.id: _score_hub(h, snapshot, config) for h in sorted(hubs, key=lambda h: h.id)}


def _ordered(values: dict[str, float]) -> list[tuple[str, float]]:
    return sorted(values.items(), key=lambda kv: (-kv[1], kv[0]))


def rank(
    scores: dict[str, HubScore],
    hubs: list[Hub],
    kind: ScoreKind,
    hazard: Hazard = "overall",
    region: Region | None = None,
    top_n: int = 15,
    config: ScoringConfig = DEFAULT_CONFIG,
) -> Ranking:
    if hazard != "overall" and kind != "exposure":
        raise ValueError("a hazard other than 'overall' is only valid with kind='exposure'")
    by_id = {h.id: h for h in hubs}
    values = {}
    for hub_id, s in scores.items():
        if region is not None and by_id[hub_id].region != region:
            continue
        if kind == "priority":
            values[hub_id] = s.priority
        elif kind == "bad_year":
            values[hub_id] = s.bad_year_days
        elif hazard == "overall":
            values[hub_id] = s.exposure
        else:
            values[hub_id] = s.families[hazard].score

    def item_band(hub_id: str, v: float) -> Band | None:
        if kind == "bad_year":  # no meaningful band on the tail lens: most hubs would read "high"
            return None
        if kind == "exposure" and hazard != "overall":
            return scores[hub_id].families[hazard].band
        return band(v, config)

    items = [
        RankedHub(rank=i, hub_id=hub_id, name=by_id[hub_id].name, value=v, band=item_band(hub_id, v))
        for i, (hub_id, v) in enumerate(_ordered(values)[:top_n], start=1)
    ]
    data_as_of = next(iter(scores.values())).data_as_of if scores else ""
    return Ranking(kind=kind, hazard=hazard, region=region, items=items,
                   band_thresholds=_thresholds(config), data_as_of=data_as_of)


def score_rows(scores: dict[str, HubScore], hubs: list[Hub]) -> list[ScoreRow]:
    by_id = {h.id: h for h in hubs}
    order = _ordered({k: v.priority for k, v in scores.items()})
    return [
        ScoreRow(hub_id=k, name=by_id[k].name, region=by_id[k].region, exposure=scores[k].exposure,
                 exposure_band=scores[k].exposure_band, priority=scores[k].priority,
                 priority_band=scores[k].priority_band, top_driver=scores[k].top_driver,
                 exposure_days_per_year=scores[k].exposure_days_per_year, bad_year_days=scores[k].bad_year_days,
                 hurricane_10yr_probability_pct=scores[k].hurricane_10yr_probability_pct)
        for k, _ in order
    ]


# ---------- weather statistics ----------

METRICS: dict[str, dict[str, Any]] = {
    "snow_days_pct": dict(var="snowfall_sum", test=lambda v: v >= 0.1, kind="pct", unit="%",
                          definition="share of days with snowfall >= 0.1 cm"),
    "heavy_rain_days": dict(var="precipitation_sum", test=lambda v: v >= 25, kind="count", unit="days",
                            definition="days with precipitation >= 25 mm"),
    "freezing_days_pct": dict(var="temperature_2m_min", test=lambda v: v <= 0, kind="pct", unit="%",
                              definition="share of days with minimum temperature <= 0 C"),
    "high_wind_days": dict(var="wind_gusts_10m_max", test=lambda v: v >= 60, kind="count", unit="days",
                           definition="days with maximum wind gust >= 60 km/h"),
    "total_snowfall_cm": dict(var="snowfall_sum", kind="sum", unit="cm", definition="total snowfall in the year"),
    "total_precip_mm": dict(var="precipitation_sum", kind="sum", unit="mm", definition="total precipitation in the year"),
}


def weather_stat(snapshot: Snapshot, hub_id: str, metric: Metric, year: int) -> WeatherStat:
    series = snapshot.weather["hubs"].get(hub_id)
    if series is None:
        raise DataUnavailable(f"no weather data for hub '{hub_id}'")
    spec = METRICS.get(metric)
    if spec is None:
        raise DataUnavailable(f"unsupported metric '{metric}'")
    first, last = int(snapshot.weather["start"][:4]), int(snapshot.weather["end"][:4])
    if not snapshot.weather["start"].endswith("01-01"):
        first += 1
    if not snapshot.weather["end"].endswith("12-31"):
        last -= 1
    if not first <= year <= last:
        raise DataUnavailable(f"the snapshot covers full years {first}-{last} only; {year} is not available")
    prefix = f"{year}-"
    values = [v for t, v in zip(series["time"], series[spec["var"]]) if t.startswith(prefix) and v is not None]
    days_in_year = (date(year + 1, 1, 1) - date(year, 1, 1)).days
    if len(values) < days_in_year:
        raise DataUnavailable(f"{year} is incomplete in the snapshot ({len(values)} of {days_in_year} days)")
    denominator = float(len(values))
    if spec["kind"] == "sum":
        numerator = _r(sum(values), 1)
        value = numerator
    else:
        numerator = float(sum(1 for v in values if spec["test"](v)))
        value = _r(100 * numerator / denominator, 1) if spec["kind"] == "pct" else numerator
    return WeatherStat(
        hub_id=hub_id, metric=metric, year=year, value=value, numerator=numerator, denominator=denominator,
        unit=spec["unit"], definition=f"{spec['definition']} (numerator over all days in {year})",
        source=f"Open-Meteo Historical Weather API (ERA5 reanalysis), {OPEN_METEO_URL}",
        data_as_of=snapshot.weather["fetched_at"][:10],
    )


# ---------- what-if ----------


def what_if(hubs: list[Hub], snapshot: Snapshot, inputs: WhatIfInput,
            config: ScoringConfig = DEFAULT_CONFIG) -> WhatIfResult:
    by_id = {h.id: h for h in hubs}
    costs = inputs.upgrade_costs or []
    unknown = [c.hub_id for c in costs if c.hub_id not in by_id]
    if unknown:
        raise ValueError(f"unknown hub id(s) in upgrade_costs: {', '.join(unknown)}; valid: {', '.join(sorted(by_id))}")
    seen = [c.hub_id for c in costs]
    if len(seen) != len(set(seen)):
        raise ValueError("each hub may appear only once in upgrade_costs")

    weights = inputs.family_weights.model_dump(exclude_none=True) if inputs.family_weights else None
    effective = _effective_weights(weights, config)
    mult = _multipliers(effective, config)
    priorities = {}
    for hub in sorted(hubs, key=lambda h: h.id):
        fam = _family_days(hub, snapshot, config)
        days = sum(mult[f] * fam[f][0] for f in FAMILIES)
        p, _ = _priority(normalize(days, config.exposure_days_cap), snapshot.nri["counties"][hub.county_fips], config)
        priorities[hub.id] = _r(p, 1)
    ranking = [
        RankedHub(rank=i, hub_id=k, name=by_id[k].name, value=v, band=band(v, config))
        for i, (k, v) in enumerate(_ordered(priorities), start=1)
    ]
    per_million = None
    if costs:
        ratio = {c.hub_id: _r(priorities[c.hub_id] / c.cost_musd, 2) for c in costs}
        cost_of = {c.hub_id: c.cost_musd for c in costs}
        per_million = [
            PerMillionHub(rank=i, hub_id=k, name=by_id[k].name, priority=priorities[k],
                          cost_musd=cost_of[k], priority_per_million=v)
            for i, (k, v) in enumerate(_ordered(ratio), start=1)
        ]
    shares = {f: _r(effective[f], 3) for f in FAMILIES}
    note = (
        "Recomputed investment priority with analyst-supplied inputs. Family weights set how much one "
        f"disruption day from each family counts (renormalized: {', '.join(f'{f} {w:g}' for f, w in shares.items())}; "
        "default is equal). Upgrade costs are analyst-supplied, in USD millions."
    )
    return WhatIfResult(kind="priority", inputs_echo=inputs, ranking=ranking, per_million_ranking=per_million,
                        note=note, data_as_of=snapshot.data_as_of)


# ---------- observed history at the hub point ----------

HISTORY_NOTE = (
    "Observed at the hub point (ERA5 reanalysis, about 25 km grid); hurricanes are not captured by daily data, "
    "see the hurricane probability instead; observed signal only, not FEMA's long-term frequency."
)


def hub_history(hubs: list[Hub], snapshot: Snapshot, hub_id: str, config: ScoringConfig = DEFAULT_CONFIG) -> HubHistory:
    """Observed disruption days per calendar year and the average per month, at the hub point.

    Same day rules as the exposure KPI's observed signal (`_disruption_day`). Full calendar years of the snapshot
    only. Deterministic: worst year ties go to the earliest year, peak months ties to the earlier month.
    """
    hub = next((h for h in hubs if h.id == hub_id), None)
    series = snapshot.weather["hubs"].get(hub_id)
    if hub is None or series is None:
        raise DataUnavailable(f"no weather history for hub '{hub_id}'")
    first, last = int(snapshot.weather["start"][:4]), int(snapshot.weather["end"][:4])
    if not snapshot.weather["start"].endswith("01-01"):
        first += 1
    if not snapshot.weather["end"].endswith("12-31"):
        last -= 1
    observed = [f for f in FAMILIES if f != "hurricane"]
    per_year = {y: {f: 0 for f in observed} for y in range(first, last + 1)}
    per_month = {m: {f: 0 for f in observed} for m in range(1, 13)}
    for i, t in enumerate(series["time"]):
        year = int(t[:4])
        if year not in per_year:
            continue
        for f, hit in _disruption_day(series, i, config).items():
            if hit:
                per_year[year][f] += 1
                per_month[int(t[5:7])][f] += 1
    n_years = len(per_year) or 1

    def row(counts: dict[str, float]) -> tuple[dict[Family, float], float]:
        days = {f: _r(float(counts.get(f, 0.0)), 1) for f in FAMILIES}
        return days, _r(sum(counts.values()), 1)

    years = []
    for y, counts in per_year.items():
        days, total = row(counts)
        years.append(YearDays(year=y, days=days, total=total))
    months = []
    month_totals = {}
    for m, counts in per_month.items():
        avg = {f: c / n_years for f, c in counts.items()}
        month_totals[m] = sum(avg.values())
        days, total = row(avg)
        months.append(MonthDays(month=m, days=days, total=total))
    worst = max(per_year, key=lambda y: (sum(per_year[y].values()), -y))
    peaks = [m for m in sorted(month_totals, key=lambda m: (-month_totals[m], m)) if month_totals[m] > 0][:3]
    return HubHistory(
        hub_id=hub.id, name=hub.name, start_year=first, end_year=last, years=years, months=months,
        worst_year=worst, peak_months=peaks, thresholds=disruption_rules(config), note=HISTORY_NOTE,
        data_as_of=snapshot.weather["fetched_at"][:10],
    )
