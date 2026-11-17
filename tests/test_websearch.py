"""web_search: result parsing, tool registration and the grounding rule for web figures."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app import grounding, tools, websearch
from app.schemas import AgentAnswer, Figure

PORT = "https://porthouston.com/news/terminal-status-2026-11-16"
NEWS = "https://www.example-news.com/houston/fog-closes-ship-channel"


def _response(results: list[dict], consulted: list[str], cited: list[str] = ()) -> SimpleNamespace:
    """A Responses API response shaped like openai's: a web_search_call with sources, then the JSON message."""
    return SimpleNamespace(
        output_text=json.dumps({"results": results}),
        output=[
            {"type": "web_search_call", "action": {"type": "search", "sources": [{"type": "url", "url": u} for u in consulted]}},
            {"type": "message", "content": [{"type": "output_text", "annotations": [{"type": "url_citation", "url": u} for u in cited]}]},
        ],
    )


def _row(url: str, snippet: str, title: str = "Port update", published: str | None = "2026-11-16") -> dict:
    return {"title": title, "url": url, "snippet": snippet, "published": published}


WEB_RESULT = websearch.WebSearchResult(
    query="Port of Houston closure this week",
    results=[
        websearch.WebResult(title="Port Houston terminal status", url=PORT, snippet="Barbours Cut reports 12 ships at anchor and normal gate hours.", published="2026-11-16"),
        websearch.WebResult(title="Fog closes Houston Ship Channel", url=NEWS, snippet="Pilots paused boarding for 9.5 hours on Monday.", published=None),
    ],
    searched_at="2026-11-17T22:00:00Z",
    note=websearch.NOTE,
).model_dump(mode="json")


def _answer(text: str, figures: list[Figure]) -> AgentAnswer:
    return AgentAnswer(answer=text, hubs=["houston"], ranking=None, figures=figures, assumptions=[], uncertainty="From the web.",
                       data_available=True, in_scope=True)


def _web_fig(value: float, url: str = PORT) -> Figure:
    return Figure(hub_id="houston", label="ships at anchor", value=value, unit="ships", source_tool="web_search", source_field=url, family=None)


# ---------- parsing ----------


def test_parse_keeps_only_urls_the_search_consulted_or_cited():
    resp = _response(
        [_row(PORT, "ok"), _row("https://invented.example/page", "made up"), _row(NEWS + "/", "cited one"), _row(PORT + "#top", "duplicate")],
        consulted=[PORT],
        cited=[NEWS],
    )
    out = websearch.parse_results(resp, "q")
    assert [r.url for r in out.results] == [PORT, NEWS + "/"]  # invented URL dropped, fragment duplicate dropped
    assert out.note.startswith("From the web, not from our scoring data")


def test_parse_cleans_dates_and_caps_snippets_and_count():
    rows = [_row(f"https://a.example/{i}", "x " * 400, published="Nov 16") for i in range(8)]
    out = websearch.parse_results(_response(rows, consulted=[r["url"] for r in rows]), "q")
    assert len(out.results) == websearch.MAX_RESULTS
    assert all(r.published is None for r in out.results)
    assert all(len(r.snippet) <= websearch.MAX_SNIPPET_CHARS for r in out.results)


def test_parse_survives_non_json_output():
    resp = SimpleNamespace(output_text="sorry, no JSON", output=[])
    assert websearch.parse_results(resp, "q").results == []


def test_normalize_url_ignores_trailing_slash_fragment_and_tracking():
    assert websearch.normalize_url("HTTPS://Example.com/a/?utm_source=x&id=3#frag") == websearch.normalize_url("https://example.com/a?id=3")


# ---------- tool registration ----------


def test_web_search_is_registered_with_a_strict_query_schema():
    assert "web_search" in [f.__name__ for f in tools.TOOL_FUNCTIONS]
    schema = tools.ARG_MODELS["web_search"].model_json_schema()
    assert schema["required"] == ["query"] and schema["additionalProperties"] is False
    assert "never" in tools.web_search.__doc__.lower() and "scores" in tools.web_search.__doc__.lower()


async def test_web_search_tool_returns_results(monkeypatch):
    async def fake_search(query, *, client=None):
        return websearch.WebSearchResult.model_validate({**WEB_RESULT, "query": query})

    monkeypatch.setattr(websearch, "search", fake_search)
    out = await tools.run_tool("web_search", json.dumps({"query": "Houston port closure"}))
    assert out["query"] == "Houston port closure" and out["results"][0]["url"] == PORT


async def test_web_search_tool_failure_is_a_tool_error(monkeypatch):
    async def boom(query, *, client=None):
        raise TimeoutError("slow")

    monkeypatch.setattr(websearch, "search", boom)
    out = await tools.run_tool("web_search", json.dumps({"query": "Houston port closure"}))
    assert set(out) == {"error", "retryable", "hint"} and "web search unavailable" in out["error"]


async def test_web_search_rejects_empty_query():
    out = await tools.run_tool("web_search", json.dumps({"query": ""}))
    assert "error" in out


# ---------- grounding ----------

OUTPUTS = [grounding.ToolOutput("web_search", WEB_RESULT)]


def test_web_number_present_in_cited_result_passes():
    answer = _answer("From the web: Port Houston reported 12 ships at anchor.", [_web_fig(12)])
    assert grounding.check(answer, OUTPUTS, None) == []


def test_web_number_absent_from_cited_result_fails():
    answer = _answer("From the web: Port Houston reported 14 ships at anchor.", [_web_fig(14)])
    errors = grounding.check(answer, OUTPUTS, None)
    assert len(errors) == 1 and "do not contain that number" in errors[0]


def test_web_number_from_another_result_fails():
    # 9.5 is in the news result, not in the port result the figure cites
    answer = _answer("From the web: boarding paused for 9.5 hours.", [_web_fig(9.5, PORT)])
    assert grounding.check(answer, OUTPUTS, None)
    ok = _answer("From the web: boarding paused for 9.5 hours.", [_web_fig(9.5, NEWS)])
    assert grounding.check(ok, OUTPUTS, None) == []


def test_web_figure_with_unknown_url_fails():
    errors = grounding.check(_answer("From the web: 12 ships.", [_web_fig(12, "https://elsewhere.example/x")]), OUTPUTS, None)
    assert errors and "not the url of any web_search result" in errors[0]


def test_web_figure_without_a_web_search_call_fails():
    errors = grounding.check(_answer("From the web: 12 ships.", [_web_fig(12)]), [], None)
    assert errors and "no web_search result exists" in errors[0]


def test_web_figure_cannot_use_a_field_name():
    fig = Figure(hub_id="houston", label="ships", value=12, unit="ships", source_tool="web_search", source_field="snippet", family=None)
    assert grounding.check(_answer("From the web: 12 ships.", [fig]), OUTPUTS, None)


def test_web_number_in_text_still_needs_a_figure():
    errors = grounding.check(_answer("From the web: boarding paused for 9.5 hours.", []), OUTPUTS, None)
    assert errors and "not in figures" in errors[0]


def test_web_result_never_grounds_a_score_figure():
    # a score figure citing get_hub_risk cannot be satisfied by a number that only appears in web text
    fig = Figure(hub_id="houston", label="exposure", value=12, unit="score 0-100", source_tool="get_hub_risk", source_field="exposure", family=None)
    assert grounding.check(_answer("Exposure is 12.", [fig]), OUTPUTS, None)


def test_drop_ungrounded_keeps_valid_web_figures():
    answer = _answer("x", [_web_fig(12), _web_fig(99)])
    kept = grounding.drop_ungrounded_figures(answer, OUTPUTS)
    assert [f.value for f in kept.figures] == [12]


@pytest.mark.parametrize("value", [0.0, 12.0])
def test_web_error_result_is_not_a_source(value):
    err = grounding.ToolOutput("web_search", {"error": "web search unavailable: X", "retryable": False, "hint": "h"})
    assert grounding.check(_answer("From the web.", [_web_fig(value)]), [err], None)
