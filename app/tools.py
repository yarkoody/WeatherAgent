"""The seven agent tools: thin, validated wrappers over scoring and the NWS client.

Each tool validates its own arguments, returns a Pydantic model (or list of models), and
never raises: any failure becomes a `ToolError` with a hint the model can act on.
`run_tool(name, arguments_json)` is the single entry point the agent loop uses.
"""

from __future__ import annotations

import asyncio
import contextvars
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
    score: ScoreKind = Field(description="'exposure' (typical-year weather disruption), 'priority' (investment priority) "
                                         "or 'bad_year' (average lost days in the worst 1 in 20 years; no band).")
    hazard: Hazard = Field(description="Hazard family to rank by; anything but 'overall' needs score='exposure'.")
    region: Region | None = Field(default=None, description="Region filter, or null for all hubs.")
    top_n: int = Field(ge=1, le=15, description="How many hubs to return (1-15).")


class GetHubRiskArgs(_Args):
    hub_id: str = Field(description="Hub id (e.g. 'kansas_city'), hub city, nickname ('DFW') or any US city in a hub's metro area ('Fort Worth', 'Portland, OR').")


class CompareHubsArgs(_Args):
    hub_ids: list[str] = Field(min_length=2, max_length=5, description="2 to 5 hub ids, hub cities or US city names.")
    hazards: list[Hazard] = Field(min_length=1, description="Hazards the comparison is about, e.g. ['overall'] or ['winter'].")


class WeatherStatArgs(_Args):
    hub_id: str = Field(description="Hub id (e.g. 'kansas_city'), hub city, nickname ('DFW') or any US city in a hub's metro area ('Fort Worth', 'Portland, OR').")
    metric: Metric = Field(description="Which statistic to compute.")
    year: int = Field(description="Calendar year; the snapshot covers full years 2015-2025.")


class GetActiveAlertsArgs(_Args):
    hub_id: str = Field(description="Hub id (e.g. 'kansas_city'), hub city, nickname ('DFW') or any US city in a hub's metro area ('Fort Worth', 'Portland, OR').")


class WhatIfArgs(_Args):
    family_weights: FamilyWeights | None = Field(
        default=None, description="Analyst-supplied relative weight of a disruption day per family; omitted families keep the default.")
    upgrade_costs: list[HubCost] | None = Field(
        default=None, description="Analyst-supplied upgrade cost per hub in USD millions; adds a priority-per-million ranking.")


class GetHubHistoryArgs(_Args):
    hub_id: str = Field(description="Hub id (e.g. 'kansas_city'), hub city, nickname ('DFW') or any US city in a hub's "
                                    "metro area ('Fort Worth', 'Portland, OR').")


ARG_MODELS: dict[str, type[BaseModel]] = {
    "list_hubs": ListHubsArgs,
    "rank_hubs": RankHubsArgs,
    "get_hub_risk": GetHubRiskArgs,
    "compare_hubs": CompareHubsArgs,
    "weather_stat": WeatherStatArgs,
    "get_active_alerts": GetActiveAlertsArgs,
    "what_if": WhatIfArgs,
    "get_hub_history": GetHubHistoryArgs,
}

# ---------- shared state and helpers ----------


@functools.cache
def _state() -> tuple[list, scoring.Snapshot, dict]:
    hubs = scoring.load_hubs()
    snapshot = scoring.load_snapshot()
    return hubs, snapshot, scoring.score_all(hubs, snapshot)


class _UnknownHub(Exception):
    pass


class _NoHubInMetro(Exception):
    def __init__(self, value: str, metro: str):
        super().__init__(value)
        self.value, self.metro = value, metro


class _AmbiguousCity(Exception):
    def __init__(self, value: str, options: list[str]):
        super().__init__(value)
        self.value, self.options = value, options


# Notes about names resolved through a nickname or an OMB metro area, collected per run_tool call.
_NOTES: contextvars.ContextVar[list[str] | None] = contextvars.ContextVar("resolution_notes", default=None)
_STATES = set(data.STATE_FIPS.values())
_OMB = "OMB, July 2023"


def _norm(text: str) -> str:
    t = text.strip().lower().replace("_", " ").replace("-", " ").replace(".", " ")
    t = " ".join(t.split())
    t = " ".join("st" if w == "saint" else w for w in t.split())
    return t[:-4] if t.endswith(" hub") else t


def _split_state(text: str) -> tuple[str, str | None]:
    """'Portland, OR' / 'Portland OR' -> ('portland', 'OR'); no state -> (name, None)."""
    if "," in text:
        name, _, st = text.rpartition(",")
        if st.strip().upper() in _STATES:
            return _norm(name), st.strip().upper()
    words = text.split()
    if len(words) > 1 and words[-1].upper().strip(".") in _STATES and len(words[-1].strip(".")) == 2:
        return _norm(" ".join(words[:-1])), words[-1].upper().strip(".")
    return _norm(text), None


@functools.cache
def _places() -> tuple[dict[str, str], dict[str, list[tuple[str, str, str]]], dict[str, dict]]:
    """(nicknames, normalized city name -> [(name, state, cbsa)], cbsas) from the committed data files."""
    def load(name: str) -> dict:
        path = data.DATA_DIR / name
        return json.loads(path.read_text()) if path.exists() else {}

    nick = {_norm(k): v for k, v in load("hub_nicknames.json").get("nicknames", {}).items()}
    metro = load("metro_cities.json")
    cities: dict[str, list[tuple[str, str, str]]] = {}
    for c in metro.get("cities", []):
        cities.setdefault(_norm(c["name"]), []).append((c["name"], c["state"], c["cbsa"]))
    return nick, cities, metro.get("cbsas", {})


def _match(text: str) -> tuple[str, str | None]:
    """(hub id, metro title if matched through an OMB metro area). Raises the resolution errors."""
    hubs = _state()[0]
    name, state = _split_state(text)
    for h in hubs:
        if name in (h.id.replace("_", " "), _norm(h.city), _norm(h.name)) and state in (None, h.state):
            return h.id, None
    _, cities, cbsas = _places()
    found = [c for c in cities.get(name, []) if state in (None, c[1])]
    codes = sorted({c[2] for c in found})
    if not codes:
        raise _UnknownHub(text)
    if len(codes) > 1:
        raise _AmbiguousCity(text, [f"{n}, {st} ({cbsas.get(code, {}).get('title', code)})" for n, st, code in sorted(found)])
    metro = cbsas.get(codes[0], {})
    if not metro.get("hub_id"):
        raise _NoHubInMetro(text, metro.get("title", codes[0]))
    return metro["hub_id"], metro["title"]


def _resolve(value: str) -> str:
    """Map a hub id, hub name, city, nickname or any US principal city to a hub id.

    Order: id / hub name / hub city (optionally 'City, ST'), then hand-written nicknames, then the OMB
    metro area of the city (data/metro_cities.json). A nickname or metro match adds a resolution note.
    """
    nicknames = _places()[0]
    target = nicknames.get(_norm(value))
    hub_id, metro = _match(target or value)
    if target is None and metro is None:
        return hub_id
    hub = next(h for h in _state()[0] if h.id == hub_id)
    shown = f"'{value}' ({target})" if target and metro else f"'{value}'"
    if metro:
        note = f"Resolved {shown} to the {hub.name} ({hub.city}, {hub.state}): both are in the {metro} metro area ({_OMB})."
    else:
        note = f"Resolved {shown} to the {hub.name} ({hub.city}, {hub.state}): a common name for {target}."
    notes = _NOTES.get()
    if notes is not None and note not in notes:
        notes.append(note)
    return hub_id


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
        except _NoHubInMetro as exc:
            ids = ", ".join(sorted(h.id for h in _state()[0]))
            return ToolError(error=f"'{exc.value}' is in the {exc.metro} metro area, where there is no hub",
                             retryable=False,
                             hint=f"Tell the analyst there is no hub there. Hubs: {ids}.")
        except _AmbiguousCity as exc:
            return ToolError(error=f"'{exc.value}' matches several metro areas: {'; '.join(exc.options)}",
                             retryable=False,
                             hint="Ask the analyst which state they mean, then call again with 'City, ST'.")
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
    The other tools already accept hub ids, hub cities, common nicknames and any US city in a hub's metro area,
    so call this only for a misspelling or to check which places are hubs."""
    hubs = _state()[0]
    return [h for h in hubs if region is None or h.region == region]


@_tool
async def rank_hubs(score: ScoreKind, hazard: Hazard = "overall", region: Region | None = None, top_n: int = 15):
    """Rank hubs by 'exposure' (expected weather-disruption days in a typical year, as a 0-100 index; can be per
    hazard family), by 'priority' (investment priority: exposure amplified by people served and resilience gap) or
    by 'bad_year' (average lost days in the worst 1 in 20 years; overall only, items have no band). Returns the
    ordered hubs with value
    and band, the band thresholds and the data date. Use it for any 'which hubs are most/least...' question."""
    hubs, _, scores = _state()
    return scoring.rank(scores, hubs, score, hazard=hazard, region=region, top_n=top_n)


@_tool
async def get_hub_risk(hub_id: str):
    """Full risk breakdown for one hub: exposure and priority scores with bands, every signal (raw value, days per
    year, weight, contribution, source), each family's share of disruption days, the top driver and typical upgrade
    categories. Use it to explain why a hub scores the way it does.
    A city resolved through a nickname or its OMB metro area adds resolution_notes to the result: open the answer with that note."""
    hubs, _, scores = _state()
    return scores[_resolve(hub_id)]


@_tool
async def compare_hubs(hub_ids: list[str], hazards: list[Hazard]):
    """Side-by-side full breakdowns for 2 to 5 hubs, for the hazards the analyst asked about.
    Use it for 'compare X and Y' questions.
    A city resolved through a nickname or its OMB metro area adds resolution_notes to the result: open the answer with that note."""
    _, snapshot, scores = _state()
    ids = list(dict.fromkeys(_resolve(h) for h in hub_ids))
    if len(ids) < 2:
        raise ValueError("compare_hubs needs at least 2 different hubs")
    return HubComparison(hubs=[scores[i] for i in ids], hazards=hazards, data_as_of=snapshot.data_as_of)


@_tool
async def weather_stat(hub_id: str, metric: Metric, year: int):
    """One observed weather statistic for a hub and calendar year (2015-2025) from the Open-Meteo snapshot:
    value, numerator, denominator, unit and definition. Use it for questions like 'what % of days had snow in
    Chicago in 2025'. Years outside the snapshot return an error: answer that the data is not available.
    A city resolved through a nickname or its OMB metro area adds resolution_notes to the result: open the answer with that note."""
    _, snapshot, _ = _state()
    return scoring.weather_stat(snapshot, _resolve(hub_id), metric, year)


def _alert(a: dict) -> NwsAlert:
    return NwsAlert(event=a.get("event") or "Unknown", severity=a.get("severity") or "Unknown",
                    headline=a.get("headline") or "", expires=a.get("expires"))


@_tool
async def get_active_alerts(hub_id: str):
    """Live official NWS alerts at the hub location right now (event, severity, headline, expiry). Not part of any
    score: investment scores are multi-year. Use it only when the analyst asks about current alerts or conditions.
    A city resolved through a nickname or its OMB metro area adds resolution_notes to the result: open the answer with that note."""
    hubs = _state()[0]
    hub = next(h for h in hubs if h.id == _resolve(hub_id))
    raw = await asyncio.to_thread(data.fetch_nws_alerts, hub.lat, hub.lon)
    return ActiveAlerts(hub_id=hub.id, alerts=[_alert(a) for a in raw],
                        fetched_at=datetime.now(timezone.utc).isoformat(timespec="seconds"))


@_tool
async def what_if(family_weights: FamilyWeights | None = None, upgrade_costs: list[HubCost] | None = None):
    """Recompute the investment-priority ranking with analyst-supplied inputs: relative family weights (how much a
    disruption day from each hazard family counts) and/or upgrade costs per hub in USD millions (adds a
    priority-per-million ranking). Echoes the inputs; label them 'analyst-supplied' in the answer.
    A city resolved through a nickname or its OMB metro area adds resolution_notes to the result: open the answer with that note."""
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


@_tool
async def get_hub_history(hub_id: str):
    """Observed weather history at the hub point, 2015-2025: disruption days per calendar year and the average per
    month, per hazard family, with the worst year, the peak months and the day rules used. Use it for history,
    year-to-year variability, "worst year", "when does it peak", seasonality and staffing or preparation timing
    questions. It is observed weather only (hurricanes are not captured by daily data), not the typical-year
    exposure score; do not read a climate trend into 11 years.
    A city resolved through a nickname or its OMB metro area adds resolution_notes to the result: open the answer with that note."""
    hubs, snapshot, _ = _state()
    return scoring.hub_history(hubs, snapshot, _resolve(hub_id))


TOOL_FUNCTIONS: list[Callable[..., Awaitable[Any]]] = [
    list_hubs, rank_hubs, get_hub_risk, compare_hubs, weather_stat, get_active_alerts, what_if, get_hub_history,
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
    Returns a dict, or a list of dicts for list_hubs. When a hub name was resolved through a nickname or an
    OMB metro area, the dict gets "resolution_notes": [str] saying how."""
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
    token = _NOTES.set([])
    try:
        out = _dump(await fn(**args))
        notes = _NOTES.get()
    finally:
        _NOTES.reset(token)
    if notes and isinstance(out, dict) and "error" not in out:
        out["resolution_notes"] = notes
    return out
