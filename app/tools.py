"""The seven agent tools: thin, validated wrappers over scoring and the NWS client.

Each tool validates its own arguments, returns a Pydantic model (or list of models), and
never raises: any failure becomes a `ToolError` with a hint the model can act on.
`run_tool(name, arguments_json)` is the single entry point the agent loop uses.
"""

from __future__ import annotations

import asyncio
import functools
import inspect
import json
from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app import data, scoring
from app.schemas import (
    ActiveAlerts, FamilyWeights, Hazard, HubComparison, HubCost, Metric, NwsAlert, Region, ScoreKind,
    ToolError, WhatIfInput,
)

# ---------- argument models (strict: used for validation and for the OpenAI tool schemas) ----------


class _Args(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ListHubsArgs(_Args):
    region: Region | None = Field(default=None, description="US Census region to filter by, or null for all hubs.")


class RankHubsArgs(_Args):
    score: ScoreKind = Field(description="'exposure' (weather disruption) or 'priority' (investment priority).")
    hazard: Hazard = Field(description="Hazard family to rank by; anything but 'overall' needs score='exposure'.")
    region: Region | None = Field(default=None, description="Region filter, or null for all hubs.")
    top_n: int = Field(ge=1, le=15, description="How many hubs to return (1-15).")


class GetHubRiskArgs(_Args):
    hub_id: str = Field(description="Hub id (e.g. 'kansas_city') or the hub's city name (e.g. 'Kansas City').")


class CompareHubsArgs(_Args):
    hub_ids: list[str] = Field(min_length=2, max_length=5, description="2 to 5 hub ids or hub city names.")
    hazards: list[Hazard] = Field(min_length=1, description="Hazards the comparison is about, e.g. ['overall'] or ['winter'].")


class WeatherStatArgs(_Args):
    hub_id: str = Field(description="Hub id or the hub's city name.")
    metric: Metric = Field(description="Which statistic to compute.")
    year: int = Field(description="Calendar year; the snapshot covers full years 2015-2025.")


class GetActiveAlertsArgs(_Args):
    hub_id: str = Field(description="Hub id or the hub's city name.")


class WhatIfArgs(_Args):
    family_weights: FamilyWeights | None = Field(
        default=None, description="Analyst-supplied relative weight of a disruption day per family; omitted families keep the default.")
    upgrade_costs: list[HubCost] | None = Field(
        default=None, description="Analyst-supplied upgrade cost per hub in USD millions; adds a priority-per-million ranking.")


ARG_MODELS: dict[str, type[BaseModel]] = {
    "list_hubs": ListHubsArgs,
    "rank_hubs": RankHubsArgs,
    "get_hub_risk": GetHubRiskArgs,
    "compare_hubs": CompareHubsArgs,
    "weather_stat": WeatherStatArgs,
    "get_active_alerts": GetActiveAlertsArgs,
    "what_if": WhatIfArgs,
}

# ---------- shared state and helpers ----------


@functools.cache
def _state() -> tuple[list, scoring.Snapshot, dict]:
    hubs = scoring.load_hubs()
    snapshot = scoring.load_snapshot()
    return hubs, snapshot, scoring.score_all(hubs, snapshot)


class _UnknownHub(Exception):
    pass


def _resolve(value: str) -> str:
    """Map an id or a typed city name ('Kansas City', 'dallas hub') to a hub id."""
    hubs = _state()[0]
    key = " ".join(value.strip().lower().replace("_", " ").replace("-", " ").split())
    if key.endswith(" hub"):
        key = key[:-4]
    for h in hubs:
        if key in (h.id.replace("_", " "), h.city.lower(), h.name.lower()):
            return h.id
    raise _UnknownHub(value)


def _unknown_hub_error(value: str) -> ToolError:
    ids = ", ".join(sorted(h.id for h in _state()[0]))
    return ToolError(
        error=f"unknown hub '{value}'",
        retryable=False,
        hint=f"Valid hub ids: {ids}. Call list_hubs to map a city name to its hub id; if the city is not a hub, say so.",
    )


def _validation_error(name: str, exc: ValidationError) -> ToolError:
    parts = [f"{'.'.join(str(x) for x in e['loc']) or 'arguments'}: {e['msg']}" for e in exc.errors()]
    return ToolError(error=f"invalid arguments for {name}: " + "; ".join(parts), retryable=False,
                     hint="Fix the arguments to match the tool schema and call again.")


def _tool(fn: Callable[..., Awaitable[Any]]) -> Callable[..., Awaitable[Any]]:
    """Validate kwargs with the tool's args model and turn every failure into a ToolError."""
    name = fn.__name__
    # Python defaults live on the function signature, not in the args model, so the strict schema has no "default".
    defaults = {k: p.default for k, p in inspect.signature(fn).parameters.items() if p.default is not p.empty}

    @functools.wraps(fn)
    async def wrapper(**kwargs: Any) -> Any:
        try:
            args = ARG_MODELS[name].model_validate({**defaults, **kwargs})
        except ValidationError as exc:
            return _validation_error(name, exc)
        try:
            return await fn(**{k: getattr(args, k) for k in type(args).model_fields})
        except _UnknownHub as exc:
            return _unknown_hub_error(str(exc))
        except scoring.DataUnavailable as exc:
            return ToolError(error=str(exc), retryable=False,
                             hint="This data is not in the snapshot: tell the analyst it is not available "
                                  "(data_available: false) and offer what is available.")
        except data.UpstreamError as exc:
            return ToolError(error=f"live data source unavailable: {exc}", retryable=exc.retryable,
                             hint="The live source failed after retries; you may try once more, otherwise say "
                                  "live alerts could not be fetched right now.")
        except ValueError as exc:
            return ToolError(error=str(exc), retryable=False, hint="Correct the arguments and call again.")
        except Exception as exc:  # last line of defence: tools never raise
            return ToolError(error=f"{name} failed: {type(exc).__name__}", retryable=False,
                             hint="Internal error; answer with the data you already have.")

    return wrapper


# ---------- tools ----------


@_tool
async def list_hubs(region: Region | None = None) -> list:
    """List the logistics hubs (id, name, city, state, region, coordinates, county FIPS), optionally for one region.
    The other tools already accept a hub id or the hub's city name, so call this only to map a name that is
    neither (an abbreviation like 'KC', a misspelling) to its hub id, or to check which places are hubs."""
    hubs = _state()[0]
    return [h for h in hubs if region is None or h.region == region]


@_tool
async def rank_hubs(score: ScoreKind, hazard: Hazard = "overall", region: Region | None = None, top_n: int = 15):
    """Rank hubs by 'exposure' (expected weather-disruption days, as a 0-100 index; can be per hazard family) or by
    'priority' (investment priority: exposure, people served, resilience gap). Returns the ordered hubs with value
    and band, the band thresholds and the data date. Use it for any 'which hubs are most/least...' question."""
    hubs, _, scores = _state()
    return scoring.rank(scores, hubs, score, hazard=hazard, region=region, top_n=top_n)


@_tool
async def get_hub_risk(hub_id: str):
    """Full risk breakdown for one hub: exposure and priority scores with bands, every signal (raw value, days per
    year, weight, contribution, source), each family's share of disruption days, the top driver and typical upgrade
    categories. Use it to explain why a hub scores the way it does."""
    hubs, _, scores = _state()
    return scores[_resolve(hub_id)]


@_tool
async def compare_hubs(hub_ids: list[str], hazards: list[Hazard]):
    """Side-by-side full breakdowns for 2 to 5 hubs, for the hazards the analyst asked about.
    Use it for 'compare X and Y' questions."""
    _, snapshot, scores = _state()
    ids = list(dict.fromkeys(_resolve(h) for h in hub_ids))
    if len(ids) < 2:
        raise ValueError("compare_hubs needs at least 2 different hubs")
    return HubComparison(hubs=[scores[i] for i in ids], hazards=hazards, data_as_of=snapshot.data_as_of)


@_tool
async def weather_stat(hub_id: str, metric: Metric, year: int):
    """One observed weather statistic for a hub and calendar year (2015-2025) from the Open-Meteo snapshot:
    value, numerator, denominator, unit and definition. Use it for questions like 'what % of days had snow in
    Chicago in 2025'. Years outside the snapshot return an error: answer that the data is not available."""
    _, snapshot, _ = _state()
    return scoring.weather_stat(snapshot, _resolve(hub_id), metric, year)


def _alert(a: dict) -> NwsAlert:
    return NwsAlert(event=a.get("event") or "Unknown", severity=a.get("severity") or "Unknown",
                    headline=a.get("headline") or "", expires=a.get("expires"))


@_tool
async def get_active_alerts(hub_id: str):
    """Live official NWS alerts at the hub location right now (event, severity, headline, expiry). Not part of any
    score: investment scores are multi-year. Use it only when the analyst asks about current alerts or conditions."""
    hubs = _state()[0]
    hub = next(h for h in hubs if h.id == _resolve(hub_id))
    raw = await asyncio.to_thread(data.fetch_nws_alerts, hub.lat, hub.lon)
    return ActiveAlerts(hub_id=hub.id, alerts=[_alert(a) for a in raw],
                        fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))


@_tool
async def what_if(family_weights: FamilyWeights | None = None, upgrade_costs: list[HubCost] | None = None):
    """Recompute the investment-priority ranking with analyst-supplied inputs: relative family weights (how much a
    disruption day from each hazard family counts) and/or upgrade costs per hub in USD millions (adds a
    priority-per-million ranking). Echoes the inputs; label them 'analyst-supplied' in the answer."""
    hubs, snapshot, _ = _state()
    costs = None
    if upgrade_costs is not None:
        costs = []
        for c in upgrade_costs:
            try:
                costs.append(HubCost(hub_id=_resolve(c.hub_id), cost_musd=c.cost_musd))
            except _UnknownHub:
                costs.append(c)  # scoring.what_if reports it with the list of valid hubs
    inputs = WhatIfInput(family_weights=family_weights, upgrade_costs=costs)
    return scoring.what_if(hubs, snapshot, inputs)


TOOL_FUNCTIONS: list[Callable[..., Awaitable[Any]]] = [
    list_hubs, rank_hubs, get_hub_risk, compare_hubs, weather_stat, get_active_alerts, what_if,
]
_BY_NAME = {f.__name__: f for f in TOOL_FUNCTIONS}


def _dump(result: Any) -> Any:
    if isinstance(result, BaseModel):
        return result.model_dump(mode="json")
    if isinstance(result, list):
        return [_dump(r) for r in result]
    return result


async def run_tool(name: str, arguments_json: str) -> Any:
    """Parse, validate, call and serialize one tool call. Never raises; errors come back as a ToolError dict.
    Returns a dict, or a list of dicts for list_hubs."""
    fn = _BY_NAME.get(name)
    if fn is None:
        return ToolError(error=f"unknown tool '{name}'", retryable=False,
                         hint=f"Available tools: {', '.join(_BY_NAME)}.").model_dump()
    try:
        args = json.loads(arguments_json or "{}")
        if not isinstance(args, dict):
            raise ValueError("arguments must be a JSON object")
    except ValueError as exc:
        return ToolError(error=f"invalid JSON arguments for {name}: {exc}", retryable=False,
                         hint="Send the arguments as one JSON object matching the tool schema.").model_dump()
    return _dump(await fn(**args))
