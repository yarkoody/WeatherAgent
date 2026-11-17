"""A3: tool registry over the committed snapshot (no network: NWS is mocked with respx)."""

import inspect
import json

import httpx
import pytest
import respx
from openai.lib._pydantic import to_strict_json_schema

from app import data, scoring, tools
from app.data import NWS_URL

EXPECTED_NAMES = ["list_hubs", "rank_hubs", "get_hub_risk", "compare_hubs", "weather_stat", "get_active_alerts", "what_if",
                  "get_hub_history"]


@pytest.fixture(autouse=True)
def no_backoff(monkeypatch):
    monkeypatch.setattr(data, "BACKOFF_SECONDS", 0.0)


def _walk_objects(schema):
    if isinstance(schema, dict):
        if schema.get("type") == "object" and "properties" in schema:
            yield schema
        for v in schema.values():
            yield from _walk_objects(v)
    elif isinstance(schema, list):
        for v in schema:
            yield from _walk_objects(v)


def test_registry_shape():
    assert [f.__name__ for f in tools.TOOL_FUNCTIONS] == EXPECTED_NAMES
    assert list(tools.ARG_MODELS) == EXPECTED_NAMES
    for fn in tools.TOOL_FUNCTIONS:
        assert inspect.iscoroutinefunction(fn)
        assert fn.__doc__ and len(fn.__doc__) > 40
    assert "hub id" in tools.list_hubs.__doc__.lower() and "city" in tools.list_hubs.__doc__.lower()


def test_tool_schemas_are_strict():
    for name, model in tools.ARG_MODELS.items():
        schema = to_strict_json_schema(model)
        objects = list(_walk_objects(schema))
        assert objects, name
        for obj in objects:
            assert obj["additionalProperties"] is False, name
            assert sorted(obj["required"]) == sorted(obj["properties"]), name
        assert '"default"' not in json.dumps(schema), name  # OpenAI strict mode does not accept defaults


@pytest.mark.parametrize("hub", ["atlantis", "Xanadu"])
async def test_unknown_hub_returns_structured_error(hub):
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": hub}))
    assert set(out) == {"error", "retryable", "hint"}
    assert hub in out["error"]
    assert out["retryable"] is False
    assert "kansas_city" in out["hint"] and "list_hubs" in out["hint"]


@pytest.mark.parametrize("typed", ["Kansas City", "kansas city hub", "Dallas Hub", "DALLAS"])
async def test_hub_name_variants_resolve(typed):
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": typed}))
    assert out["hub_id"] in {"kansas_city", "dallas"}


async def test_invalid_json_arguments_return_error():
    out = await tools.run_tool("rank_hubs", "{not json")
    assert set(out) == {"error", "retryable", "hint"}
    out = await tools.run_tool("rank_hubs", json.dumps({"score": "vibes", "hazard": "overall", "region": None, "top_n": 5}))
    assert "score" in out["error"]
    out = await tools.run_tool("no_such_tool", "{}")
    assert "no_such_tool" in out["error"]


async def test_rank_hubs_matches_scoring_rank():
    hubs, snap = scoring.load_hubs(), scoring.load_snapshot()
    expected = scoring.rank(scoring.score_all(hubs, snap), hubs, "priority", region="Midwest", top_n=3)
    out = await tools.run_tool("rank_hubs", json.dumps({"score": "priority", "hazard": "overall", "region": "Midwest", "top_n": 3}))
    assert out == expected.model_dump(mode="json")
    assert len(out["items"]) == 3


async def test_rank_hubs_hazard_with_priority_is_error():
    out = await tools.run_tool("rank_hubs", json.dumps({"score": "priority", "hazard": "winter", "region": None, "top_n": 5}))
    assert "exposure" in out["error"] or "exposure" in out["hint"]


async def test_compare_hubs_returns_breakdowns():
    out = await tools.run_tool("compare_hubs", json.dumps({"hub_ids": ["miami", "Houston"], "hazards": ["hurricane"]}))
    assert [h["hub_id"] for h in out["hubs"]] == ["miami", "houston"]
    assert out["hazards"] == ["hurricane"]
    out = await tools.run_tool("compare_hubs", json.dumps({"hub_ids": ["miami"], "hazards": ["overall"]}))
    assert "error" in out


async def test_weather_stat_year_outside_snapshot_is_not_available():
    out = await tools.run_tool("weather_stat", json.dumps({"hub_id": "denver", "metric": "snow_days_pct", "year": 2026}))
    assert "2026" in out["error"]
    assert "data_available" in out["hint"]
    ok = await tools.run_tool("weather_stat", json.dumps({"hub_id": "denver", "metric": "snow_days_pct", "year": 2025}))
    assert ok["denominator"] == 365 and ok["unit"] == "%"


@respx.mock
async def test_get_active_alerts_returns_alerts():
    respx.get(NWS_URL).mock(return_value=httpx.Response(200, json={"features": [
        {"properties": {"event": "Flood Watch", "severity": "Moderate", "headline": "Flood Watch for Harris",
                        "expires": "2026-11-18T00:00:00-06:00", "description": "free text"}}]}))
    out = await tools.run_tool("get_active_alerts", json.dumps({"hub_id": "houston"}))
    assert out["hub_id"] == "houston"
    assert out["alerts"] == [{"event": "Flood Watch", "severity": "Moderate", "headline": "Flood Watch for Harris",
                              "expires": "2026-11-18T00:00:00-06:00"}]


@respx.mock
async def test_get_active_alerts_upstream_failure_is_retryable_error():
    respx.get(NWS_URL).mock(return_value=httpx.Response(503))
    out = await tools.run_tool("get_active_alerts", json.dumps({"hub_id": "houston"}))
    assert set(out) == {"error", "retryable", "hint"}
    assert out["retryable"] is True


async def test_what_if_tool_echoes_inputs():
    args = {"family_weights": {"winter": None, "flood": None, "hurricane": 0.5, "severe_storm": None},
            "upgrade_costs": [{"hub_id": "miami", "cost_musd": 12}, {"hub_id": "chicago", "cost_musd": 8}]}
    out = await tools.run_tool("what_if", json.dumps(args))
    assert out["inputs_echo"] == args
    assert out["kind"] == "priority"
    assert {p["hub_id"] for p in out["per_million_ranking"]} == {"miami", "chicago"}
    assert "analyst-supplied" in out["note"]


async def test_what_if_unknown_hub_cost_is_error():
    out = await tools.run_tool("what_if", json.dumps({"family_weights": None, "upgrade_costs": [{"hub_id": "atlantis", "cost_musd": 5}]}))
    assert "atlantis" in out["error"]


async def test_direct_call_uses_signature_defaults():
    out = await tools.rank_hubs(score="exposure")
    assert out.hazard == "overall" and len(out.items) == 15


async def test_tools_never_raise_on_bad_direct_call():
    out = await tools.rank_hubs(score="priority", hazard="overall", region=None, top_n=99)
    assert isinstance(out, tools.ToolError)


@respx.mock
async def test_get_active_alerts_tolerates_missing_alert_fields():
    respx.get(NWS_URL).mock(return_value=httpx.Response(200, json={"features": [
        {"properties": {"event": "Special Weather Statement", "severity": None, "headline": None, "expires": None}}]}))
    out = await tools.run_tool("get_active_alerts", json.dumps({"hub_id": "denver"}))
    assert out["alerts"] == [{"event": "Special Weather Statement", "severity": "Unknown", "headline": "", "expires": None}]



@respx.mock
async def test_get_active_alerts_client_error_is_not_retryable():
    respx.get(NWS_URL).mock(return_value=httpx.Response(400))
    out = await tools.run_tool("get_active_alerts", json.dumps({"hub_id": "houston"}))
    assert out["retryable"] is False


async def test_what_if_tool_rejects_huge_weight():
    out = await tools.run_tool("what_if", json.dumps({"family_weights": {"winter": 1e9, "flood": None, "hurricane": None, "severe_storm": None}, "upgrade_costs": None}))
    assert set(out) == {"error", "retryable", "hint"}


async def test_rank_hubs_bad_year_kind():
    out = await tools.run_tool("rank_hubs", json.dumps({"score": "bad_year", "hazard": "overall", "region": None, "top_n": 3}))
    assert out["kind"] == "bad_year" and len(out["items"]) == 3
    assert all(i["band"] is None for i in out["items"])
    values = [i["value"] for i in out["items"]]
    assert values == sorted(values, reverse=True)



# ---------- city -> hub through nicknames and OMB metro areas (data/metro_cities.json) ----------


@pytest.mark.parametrize("typed,hub", [
    ("New York", "newark"), ("Fort Worth", "dallas"), ("St. Paul", "minneapolis"), ("Saint Paul", "minneapolis"),
    ("Kansas City, KS", "kansas_city"), ("Overland Park", "kansas_city"), ("Arlington, TX", "dallas"),
    ("Portland OR", None),
])
async def test_metro_city_resolves_to_its_hub(typed, hub):
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": typed}))
    if hub is None:  # Portland, OR is a known city in a metro area without a hub
        assert "no hub" in out["error"]
        return
    assert out["hub_id"] == hub
    assert len(out["resolution_notes"]) == 1 and typed in out["resolution_notes"][0]
    assert "OMB, July 2023" in out["resolution_notes"][0]


async def test_new_york_note_names_the_metro_area():
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": "New York"}))
    assert out["resolution_notes"] == [
        "Resolved 'New York' to the Newark Hub (Newark, NJ): both are in the New York-Newark-Jersey City, NY-NJ "
        "metro area (OMB, July 2023)."]


@pytest.mark.parametrize("typed,hub", [("NYC", "newark"), ("DFW", "dallas"), ("twin cities", "minneapolis"),
                                       ("KC", "kansas_city"), ("the cities", "minneapolis")])
async def test_nicknames_resolve(typed, hub):
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": typed}))
    assert out["hub_id"] == hub
    assert typed in out["resolution_notes"][0]


async def test_exact_hub_city_has_no_resolution_note():
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": "Dallas"}))
    assert "resolution_notes" not in out
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": "Kansas City, MO"}))
    assert out["hub_id"] == "kansas_city" and "resolution_notes" not in out


async def test_city_in_metro_without_hub_is_error_naming_the_metro():
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": "Boston"}))
    assert set(out) == {"error", "retryable", "hint"}
    assert "Boston-Cambridge-Newton, MA-NH" in out["error"] and "no hub" in out["error"]
    assert "newark" in out["hint"]


async def test_ambiguous_city_asks_which_state():
    out = await tools.run_tool("weather_stat", json.dumps({"hub_id": "Portland", "metric": "snow_days_pct", "year": 2025}))
    assert "Portland" in out["error"]
    assert "OR" in out["error"] and "ME" in out["error"]
    assert "state" in out["hint"].lower()


async def test_ambiguous_city_with_a_hub_option_still_asks():
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": "Arlington"}))  # TX (Dallas) or VA (no hub)
    assert "error" in out and "TX" in out["error"] and "VA" in out["error"]


async def test_unknown_place_keeps_the_unknown_hub_error():
    out = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": "Atlantis"}))
    assert out["error"] == "unknown hub 'Atlantis'"


async def test_compare_and_what_if_collect_notes():
    out = await tools.run_tool("compare_hubs", json.dumps({"hub_ids": ["New York", "Fort Worth"], "hazards": ["overall"]}))
    assert [h["hub_id"] for h in out["hubs"]] == ["newark", "dallas"]
    assert len(out["resolution_notes"]) == 2
    out = await tools.run_tool("what_if", json.dumps({"family_weights": None, "upgrade_costs": [{"hub_id": "St. Paul", "cost_musd": 5}]}))
    assert out["per_million_ranking"][0]["hub_id"] == "minneapolis"
    assert "St. Paul" in out["resolution_notes"][0]



# ---------- get_hub_history ----------


async def test_get_hub_history_returns_years_and_months():
    out = await tools.run_tool("get_hub_history", json.dumps({"hub_id": "Minneapolis"}))
    assert out["hub_id"] == "minneapolis"
    assert [y["year"] for y in out["years"]] == list(range(2015, 2026))
    assert len(out["months"]) == 12 and 1 <= len(out["peak_months"]) <= 3
    assert out["worst_year"] in range(2015, 2026)
    assert out["thresholds"]["winter"].startswith("snow >= 5 cm")
    assert "resolution_notes" not in out


async def test_get_hub_history_resolves_metro_cities_with_a_note():
    out = await tools.run_tool("get_hub_history", json.dumps({"hub_id": "New York"}))
    assert out["hub_id"] == "newark" and "New York" in out["resolution_notes"][0]


async def test_get_hub_history_errors_are_structured():
    for name in ("Atlantis", "Boston"):
        out = await tools.run_tool("get_hub_history", json.dumps({"hub_id": name}))
        assert set(out) == {"error", "retryable", "hint"}
    assert (await tools.run_tool("get_hub_history", "{}"))["error"].startswith("invalid arguments")


def test_get_hub_history_docstring_says_when_to_use_it():
    doc = tools.get_hub_history.__doc__.lower()
    for word in ("worst year", "peak", "season", "staffing", "trend", "resolution_notes"):
        assert word in doc, word


async def test_rank_hubs_reports_total_for_a_top_n_subset():
    out = await tools.run_tool("rank_hubs", json.dumps({"score": "priority", "hazard": "overall", "region": "Midwest", "top_n": 2}))
    region_size = sum(1 for h in scoring.load_hubs() if h.region == "Midwest")
    assert len(out["items"]) == 2 and out["total"] == region_size > 2
