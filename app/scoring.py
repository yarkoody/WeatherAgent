"""Deterministic scoring over the committed snapshot (spec section 6, formula v2).

Exposure is expected disruption days per year (typical year):
- modeled days = FEMA NRI events per year x days lost per event (local hazards scaled down for large
  counties, coastal flood scaled by the share of county area exposed)
- observed days = days per year at the hub point over a disruption threshold (Open-Meteo, 2015-2025)
- each family blends the two (NRI 0.6, observed 0.4; hurricane NRI only), families add up,
  and the index is min(days / 25, 1) x 100, so the 35/60 bands mean 8.75 and 15 days per year.
Family bands: 2 / 5 days per year; hurricane by the chance of at least one event in 10 years (20% / 50%).
Bad-year lens: expected days + 1.645 x sd (a 1-in-20-year year), sd from a compound-Poisson variance.
Priority = exposure x (0.6 + 0.25 x people served share + 0.15 x resilience-gap share).
Same snapshot and config always give the same output; ties break by hub_id.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict

from app.data import DATA_DIR, OPEN_METEO_URL
from app.schemas import (
    Band, BandThresholds, Family, FamilyScore, Hazard, Hub, HubScore, Metric, PerMillionHub,
    RankedHub, Ranking, Region, ScoreKind, ScoreRow, Signal, WeatherStat, WhatIfInput, WhatIfResult,
)

__all__ = [
    "DATA_DIR", "DEFAULT_CONFIG", "DataUnavailable", "FAMILIES", "ScoringConfig", "Snapshot",
    "UPGRADE_CATEGORIES", "band", "load_hubs", "load_snapshot", "normalize", "rank", "score_all",
    "score_rows", "weather_stat", "what_if",
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

    # bad-year lens: expected days + z x sd (z = 1.645, one-sided 95%: a 1-in-20-year year)
    bad_year_z: float = 1.645
    # hurricane closure-length mix for the variance only: 80% short (4 days), 20% severe (35 days)
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

    def val(var: str, i: int) -> float | None:
        return series[var][i]

    winter = sum(
        1 for i in idx
        if (val("snowfall_sum", i) or 0) >= config.snow_cm
        or (val("temperature_2m_min", i) is not None and val("temperature_2m_min", i) <= config.cold_c)
    )
    flood = sum(1 for i in idx if (val("precipitation_sum", i) or 0) >= config.heavy_rain_mm)
    severe = sum(1 for i in idx if (val("wind_gusts_10m_max", i) or 0) >= config.gust_kmh)
    return {"winter": winter / years, "flood": flood / years, "severe_storm": severe / years}, nulls


OBS_LABELS = {
    "winter": "observed winter disruption days (snow >= {snow_cm:g} cm or min temp <= {cold_c:g} C)",
    "flood": "observed heavy-rain days (precipitation >= {heavy_rain_mm:g} mm)",
    "severe_storm": "observed high-gust days (gust >= {gust_kmh:g} km/h)",
}


def _second_moment(key: str, config: ScoringConfig) -> float:
    """E[D^2] of days lost per event: fixed days, except the hurricane closure-length mix."""
    if key == "HRCN":
        return sum(share * d * d for share, d in config.hurricane_days_mix)
    return config.days_per_event[key] ** 2


def _family_days(
    hub: Hub, snapshot: Snapshot, config: ScoringConfig,
) -> dict[Family, tuple[float, list[Signal], float]]:
    """Per family: expected days per year, signals, and variance of days (for the bad-year lens).

    Variance follows the formula review: sum over sub-hazards of weight x adjusted frequency x E[D^2]
    (compound Poisson); the observed signal adds to the mean only.
    """
    county = snapshot.nri["counties"][hub.county_fips]
    observed, nulls = _observed_days(snapshot.weather["hubs"][hub.id], config)
    area = county.get("AREA") or 0
    out: dict[Family, tuple[float, list[Signal], float]] = {}
    for family in FAMILIES:
        nri_w = 1.0 if family == "hurricane" else config.nri_weight
        signals: list[Signal] = []
        days = 0.0
        variance = 0.0
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
                    note = "exposed coastal area missing in NRI; not scaled"
                else:
                    factor = min(exposed / area, 1.0)
                    note = f"{100 * factor:.1f}% of county area exposed to coastal flooding (NRI)"
            implied = (raw or 0.0) * dpe * factor
            contribution = nri_w * implied
            days += contribution
            variance += nri_w * (raw or 0.0) * factor * _second_moment(key, config)
            signals.append(Signal(
                name=f"{label} (FEMA NRI, {dpe:g} days/event)", source=NRI_SOURCE,
                raw=None if raw is None else _r(raw, 3), unit="events/year", cap=None,
                normalized=_r(implied, 3), weight=nri_w, contribution=_r(contribution, 3), note=note,
            ))
        if family != "hurricane":
            obs = observed[family]
            contribution = config.observed_weight * obs
            days += contribution
            signals.append(Signal(
                name=OBS_LABELS[family].format(**config.model_dump()), source=OBS_SOURCE,
                raw=_r(obs, 3), unit="days/year", cap=None, normalized=_r(obs, 3),
                weight=config.observed_weight, contribution=_r(contribution, 3),
                note=(f"average per year {config.observed_start} to {config.observed_end}; "
                      f"{nulls[family]} null values"),
            ))
        out[family] = (days, signals, variance)
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
    bad_year = total_days + config.bad_year_z * math.sqrt(sum(v for _, _, v in fam.values()))
    families = {
        f: FamilyScore(family=f, score=_r(normalize(fam[f][0], config.exposure_days_cap), 1),
                       days_per_year=_r(fam[f][0], 1),
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
    cap = config.exposure_days_cap
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

    def item_band(hub_id: str, v: float) -> Band:
        if kind == "bad_year":  # bad-year days on the same day cut-offs as exposure (8.75 / 15)
            return band(normalize(v, cap), config)
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
