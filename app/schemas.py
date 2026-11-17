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
ScoreKind = Literal["exposure", "priority"]
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
    signals: list[Signal]


class BandThresholds(Strict):
    """Returned with every score so the agent can cite the band cut-offs as numbers."""

    medium_from: float
    high_from: float


class HubScore(Strict):
    hub_id: str
    exposure: float  # index 0-100 = min(exposure_days_per_year / cap, 1) * 100
    exposure_days_per_year: float  # total expected disruption days per year
    exposure_band: Band
    families: dict[Family, FamilyScore]
    family_weights: dict[Family, float]
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
    band: Band


class Ranking(Strict):
    """What rank_hubs returns: the ordered hubs plus the context needed to cite them."""

    kind: ScoreKind
    hazard: Hazard
    region: Region | None
    items: list[RankedHub]
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
