"""Shared contracts between scoring, tools, agent, API and UI.

Owned by the orchestrator. Other tracks import these models and do not edit them.
Every model forbids extra fields, so the JSON schemas sent to OpenAI are strict.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Region = Literal["Midwest", "South", "West", "Northeast"]
Family = Literal["winter", "flood", "hurricane", "severe_storm"]
Hazard = Literal["overall", "winter", "flood", "hurricane", "severe_storm"]
ScoreKind = Literal["exposure", "priority", "bad_year", "people_impact", "people_served"]  # bad_year = 1-in-20-year disruption days (tail lens)
Band = Literal["low", "medium", "high"]
Metric = Literal[
    "snow_days_pct",
    "heavy_rain_days",
    "freezing_days_pct",
    "high_wind_days",
    "total_snowfall_cm",
    "total_precip_mm",
]


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# ---------- hubs and scoring ----------


class Hub(Strict):
    id: str
    name: str
    city: str
    state: str
    region: Region
    lat: float
    lon: float
    county_fips: str


class Signal(Strict):
    name: str
    source: str
    raw: float | None
    unit: str
    cap: float | None
    normalized: float
    weight: float
    contribution: float
    note: str | None = None


class FamilyScore(Strict):
    family: Family
    score: float
    days_per_year: float  # expected disruption days per year from this family
    band: Band  # family band by days (medium from 2, high from 5); hurricane by 10-year probability
    bad_year_days: float  # this family's share of the hub's bad_year_days (exact Euler allocation of TVaR95: E[family days | worst 5% of years]); the four sum to HubScore.bad_year_days
    signals: list[Signal]


class BandThresholds(Strict):
    """Returned with every score so the agent can cite the band cut-offs as numbers."""

    medium_from: float  # index value where "medium" starts (35)
    high_from: float  # index value where "high" starts (60)
    days_cap: float  # disruption days per year that map to index 100 (25)
    medium_from_days: float  # the medium cut-off in days per year (8.75)
    high_from_days: float  # the high cut-off in days per year (15)
    family_medium_from_days: float  # a hazard family is "medium" from this many days per year (2)
    family_high_from_days: float  # a hazard family is "high" from this many days per year (5)
    hurricane_medium_from_pct: float  # hurricane family band by 10-year event probability (20)
    hurricane_high_from_pct: float  # (50)


class HubScore(Strict):
    hub_id: str
    exposure: float  # index 0-100 = min(exposure_days_per_year / cap, 1) * 100
    exposure_days_per_year: float  # total expected disruption days per year (typical year)
    bad_year_days: float  # average lost days in the worst 1 in 20 years (TVaR95, exact compound-Poisson recursion)
    hurricane_10yr_probability_pct: float  # chance of at least one hurricane-class event in 10 years, 0-100
    metro_name: str  # OMB metro area (CBSA) the hub sits in
    people_served: int  # metro-area population (Census estimate), a proxy for the people a hub serves
    people_days_m: float  # people-days of disruption a year, typical year, in millions = people_served x typical days / 1e6
    people_days_bad_year_m: float  # same, in a bad year (worst 1 in 20 average)
    exposure_band: Band
    families: dict[Family, FamilyScore]
    family_weights: dict[Family, float]  # each family's share of total disruption days, in percent (0-100)
    priority: float
    priority_band: Band
    priority_signals: list[Signal]
    top_driver: Family
    upgrade_categories: list[str]
    band_thresholds: BandThresholds
    data_as_of: str  # snapshot fetch date, ISO


class HubComparison(Strict):
    hubs: list[HubScore]
    hazards: list[Hazard]
    data_as_of: str


class RankedHub(Strict):
    rank: int
    hub_id: str
    name: str
    value: float
    band: Band | None  # None for kind="bad_year" (no meaningful band on the tail lens)


class Ranking(Strict):
    """What rank_hubs returns: the ordered hubs plus the context needed to cite them."""

    kind: ScoreKind
    hazard: Hazard
    region: Region | None
    items: list[RankedHub]
    total: int = 0  # hubs matching the filter before top_n, so the UI can say "top 5 of 6"
    band_thresholds: BandThresholds
    data_as_of: str


class PerMillionHub(Strict):
    rank: int
    hub_id: str
    name: str
    priority: float
    cost_musd: float
    priority_per_million: float  # priority / cost_musd, rounded to 2 decimals


class WeatherStat(Strict):
    hub_id: str
    metric: Metric
    year: int
    value: float
    numerator: float
    denominator: float
    unit: str
    definition: str
    source: str
    data_as_of: str


class YearDays(Strict):
    year: int
    days: dict[Family, float]  # observed disruption days that calendar year, per family (hurricane is not observed: 0)
    total: float


class MonthDays(Strict):
    month: int  # 1-12
    days: dict[Family, float]  # average observed disruption days in that month across the window
    total: float


class HubHistory(Strict):
    """Observed weather history at the hub point (Open-Meteo, daily). Shows variability and seasonality."""

    hub_id: str
    name: str
    start_year: int
    end_year: int
    years: list[YearDays]
    months: list[MonthDays]
    worst_year: int  # year with the most observed disruption days
    peak_months: list[int]  # months with the highest average, most first (up to 3)
    thresholds: dict[str, str]  # family -> plain-language disruption-day rule, e.g. "snow >= 5 cm or min temp <= -18 °C"
    note: str  # data limits: reanalysis grid, hurricanes not captured by daily data, observed signal only
    data_as_of: str


class NwsAlert(Strict):
    """Live NWS alert. Free-text description and instructions are dropped on purpose (prompt-injection surface)."""

    event: str
    severity: str
    headline: str
    expires: str | None


class ActiveAlerts(Strict):
    hub_id: str
    alerts: list[NwsAlert]
    fetched_at: str


class FamilyWeights(Strict):
    """Analyst-supplied family weights for what-if. Omitted families keep their default; all are renormalized."""

    winter: float | None = Field(default=None, gt=0)
    flood: float | None = Field(default=None, gt=0)
    hurricane: float | None = Field(default=None, gt=0)
    severe_storm: float | None = Field(default=None, gt=0)


class HubCost(Strict):
    hub_id: str
    cost_musd: float = Field(ge=0.1, le=1000)


class WhatIfInput(Strict):
    family_weights: FamilyWeights | None = None
    upgrade_costs: list[HubCost] | None = None


class WhatIfResult(Strict):
    kind: ScoreKind  # always "priority": what-if re-ranks investment priority
    inputs_echo: WhatIfInput
    ranking: list[RankedHub]
    per_million_ranking: list[PerMillionHub] | None
    note: str  # states that the inputs are analyst-supplied
    data_as_of: str


class ScoreRow(Strict):
    hub_id: str
    name: str
    region: Region
    exposure: float
    exposure_band: Band
    exposure_days_per_year: float
    bad_year_days: float
    hurricane_10yr_probability_pct: float
    metro_name: str = ""
    people_served: int = 0
    people_days_m: float = 0.0
    people_days_bad_year_m: float = 0.0
    priority: float
    priority_band: Band
    top_driver: Family


# ---------- tools ----------


class ToolError(Strict):
    error: str
    retryable: bool
    hint: str


# ---------- agent answer (LLM -> code) ----------


class Figure(Strict):
    hub_id: str | None = Field(description="Hub the number is about, or null for a general figure.")
    label: str = Field(description="What the number is, e.g. 'snow days 2025'.")
    value: float = Field(description="The number exactly as a tool returned it.")
    unit: str = Field(description="Unit, e.g. '%', 'days', 'score 0-100', 'events/year'.")
    source_tool: str = Field(description="Name of the tool call that returned this number.")
    source_field: str = Field(description="The exact field name in that tool's result that holds this number, e.g. 'priority', 'bad_year_days', 'hurricane_10yr_probability_pct', 'days_per_year', 'value'.")
    family: Family | None = Field(description="The hazard family the number belongs to when the field sits inside a family (e.g. families.winter.days_per_year); otherwise null.")


class AgentAnswer(Strict):
    answer: str = Field(description="Short markdown explanation for the analyst. Every number in it must appear in figures.")
    hubs: list[str] = Field(description="Hub ids the answer is about.")
    ranking: list[str] | None = Field(description="Hub ids in ranked order, only when a ranking was asked; otherwise null.")
    figures: list[Figure] = Field(description="Every number used in the answer, copied from tool results.")
    assumptions: list[str] = Field(description="Assumptions used, including any analyst-supplied inputs.")
    uncertainty: str = Field(description="Data limits, staleness and coverage that affect this answer.")
    data_available: bool = Field(description="False when the tools could not provide the data needed.")
    in_scope: bool = Field(description="False when the question is outside hub weather-risk analysis.")


# ---------- API ----------


class Grounding(Strict):
    status: Literal["pass", "retried", "failed"]
    errors: list[str]


class ChatRequest(Strict):
    session_id: str | None = None
    message: str = Field(min_length=1, max_length=2000)


class ChatResponse(Strict):
    session_id: str
    answer: AgentAnswer
    grounding: Grounding
    trace_id: str
    follow_ups: list[str] = []  # suggested next questions, built by code from the turn (app/followups.py)


# ---------- JEV second opinion (offline cross-check; never affects scores) ----------


class JevFamilyOpinion(Strict):
    family: Family
    jev_band: Band  # JEV's rating mapped with the same cut-offs as our index (0.35 / 0.60 of its 0-1 score)
    jev_score_pct: float  # JEV's ScoreAnswer score as 0-100
    our_band: Band  # our formula's band for this family
    agrees: bool


class JevHubOpinion(Strict):
    hub_id: str
    name: str
    families: list[JevFamilyOpinion]
    agree_count: int
    total: int


class SecondOpinion(Strict):
    model: str  # the JEV model id actually used
    run_at: str  # ISO timestamp of the JEV run
    data_as_of: str  # snapshot date the inputs came from
    hubs: list[JevHubOpinion]
    agree_count: int
    total: int
    agreement_pct: float  # 0-100
    rank_correlation: dict[Family, float] | None = None  # Spearman, JEV score vs our family days, per family
    note: str  # "Independent rating ... does not affect scores ..."
