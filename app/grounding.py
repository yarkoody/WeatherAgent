"""Deterministic grounding check for the agent's final answer.

Every number the user sees must come from a tool result. The check runs in code after
the LLM's structured answer is parsed, so it does not depend on the model's honesty.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from app.schemas import AgentAnswer, Figure

# A number with optional thousands commas, decimals and a trailing %.
# A leading minus counts only when it is not glued to a word or a digit
# ("-10 °C" is negative; "2015-2025" and "top-3" are not).
_NUMBER = re.compile(r"(?<![\w.,])([-−]?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(%?)")
# ISO dates and timestamps ("data as of 2026-11-17") are not figures.
_ISO_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b")


def _parse(match: re.Match[str]) -> float:
    sign, whole, frac, _ = match.groups()
    value = float(whole.replace(",", "") + (frac or ""))
    return -value if sign else value


def numbers_in_text(text: str) -> list[float]:
    return [_parse(m) for m in _NUMBER.finditer(text)]


def _is_exempt(match: re.Match[str]) -> bool:
    """Years and small counts ("top 3", "15 hubs", "2025") need no figure."""
    sign, whole, frac, pct = match.groups()
    if sign or frac or pct or "," in whole:
        return False
    n = int(whole)
    return 1 <= n <= 15 or 1900 <= n <= 2100


_TOOL_ERROR_KEYS = {"error", "retryable", "hint"}


def _is_tool_error(obj: Any) -> bool:
    return isinstance(obj, dict) and set(obj) == _TOOL_ERROR_KEYS


def collect_numbers(obj: Any) -> list[float]:
    """Every citable number in a tool result, including numbers written inside strings.

    ToolError results and ISO dates (a date's "17" is not a figure) are skipped.
    """
    out: list[float] = []
    if isinstance(obj, bool) or obj is None:
        return out
    if isinstance(obj, (int, float)):
        out.append(float(obj))
    elif isinstance(obj, str):
        out.extend(numbers_in_text(_ISO_DATE.sub(" ", obj)))
    elif isinstance(obj, dict):
        if _is_tool_error(obj):
            return out
        for value in obj.values():
            out.extend(collect_numbers(value))
    elif isinstance(obj, (list, tuple)):
        for value in obj:
            out.extend(collect_numbers(value))
    return out


def numbers_by_hub(obj: Any) -> dict[str, list[float]]:
    """Numbers inside every object that carries a hub_id, keyed by that hub id."""
    out: dict[str, list[float]] = defaultdict(list)

    def visit(o: Any) -> None:
        if isinstance(o, dict):
            if _is_tool_error(o):
                return
            hub = o.get("hub_id")
            if isinstance(hub, str):
                out[hub].extend(collect_numbers(o))
            for value in o.values():
                visit(value)
        elif isinstance(o, (list, tuple)):
            for value in o:
                visit(value)

    visit(obj)
    return out


def matches(a: float, b: float) -> bool:
    return abs(a - b) <= max(0.05, 0.005 * abs(b))


def _found(value: float, pool: list[float]) -> bool:
    return any(matches(value, b) for b in pool)


def _fmt(value: float) -> str:
    return f"{value:g}"


def ranking_candidates(tool_results: list[Any]) -> list[list[str]]:
    """Hub orders that code returned: rank_hubs, what_if, and compare_hubs sorted by each score."""
    out: list[list[str]] = []

    def visit(obj: Any) -> None:
        if isinstance(obj, list):
            for item in obj:
                visit(item)
            return
        if not isinstance(obj, dict):
            return
        for key in ("items", "ranking", "per_million_ranking"):
            rows = obj.get(key)
            if isinstance(rows, list) and rows and all(isinstance(r, dict) and "hub_id" in r for r in rows):
                out.append([r["hub_id"] for r in rows])
        hubs = obj.get("hubs")
        if isinstance(hubs, list) and hubs and all(isinstance(h, dict) and "hub_id" in h for h in hubs):
            for score in ("exposure", "priority"):
                if all(isinstance(h.get(score), (int, float)) for h in hubs):
                    ordered = sorted(hubs, key=lambda h: (-h[score], h["hub_id"]))
                    out.append([h["hub_id"] for h in ordered])

    visit(tool_results)
    return out


def _in_order(ranking: list[str], full: list[str]) -> bool:
    """True if ranking is a subsequence of full (same relative order, no repeats)."""
    remaining = iter(full)
    return len(ranking) > 0 and all(hub in remaining for hub in ranking)


def _text_fields(answer: AgentAnswer) -> list[tuple[str, str]]:
    return [("answer", answer.answer), ("uncertainty", answer.uncertainty)] + [
        (f"assumptions[{i}]", text) for i, text in enumerate(answer.assumptions)
    ]


def _ungrounded(f: Figure, pool: list[float], by_hub: dict[str, list[float]]) -> bool:
    # A hub's figure must come from an object about that hub; general figures (hub_id null) from anywhere.
    return not _found(f.value, pool if f.hub_id is None else by_hub.get(f.hub_id, []))


def check(answer: AgentAnswer, tool_results: list[Any], expected_ranking: list[str] | None) -> list[str]:
    """Return grounding errors; an empty list means the answer is grounded.

    expected_ranking=None derives the allowed orders from the tool results. A ranking may be
    any subset of the order the code returned (top N, a filtered list) or that order reversed
    (lowest first).
    """
    errors: list[str] = []
    pool = collect_numbers(tool_results)
    by_hub = numbers_by_hub(tool_results)

    for f in answer.figures:
        if not _ungrounded(f, pool, by_hub):
            continue
        if f.hub_id is None:
            errors.append(
                f"Figure '{f.label}' has value {_fmt(f.value)}, which no tool returned. "
                "Use only numbers exactly as tools returned them."
            )
        else:
            errors.append(
                f"Figure '{f.label}' for hub {f.hub_id} has value {_fmt(f.value)}, which no tool returned for that hub. "
                "Use only numbers exactly as tools returned them, and set hub_id to null for general figures such as band thresholds."
            )

    figure_values = [f.value for f in answer.figures]
    for field, text in _text_fields(answer):
        for m in _NUMBER.finditer(_ISO_DATE.sub(" ", text)):
            if _is_exempt(m) or _found(_parse(m), figure_values):
                continue
            errors.append(f"The {field} text mentions {m.group(0)}, which is not in figures. Add it to figures or remove it.")

    if answer.ranking:
        candidates = [expected_ranking] if expected_ranking is not None else ranking_candidates(tool_results)
        if not candidates:
            errors.append("The answer has a ranking but no tool returned a ranking. Call rank_hubs or set ranking to null.")
        elif not any(_in_order(answer.ranking, c) or _in_order(answer.ranking, c[::-1]) for c in candidates):
            errors.append(
                f"The ranking {answer.ranking} does not match the order the tools returned ({candidates[-1]}). "
                "Copy the order from the tool result."
            )
    return errors


def drop_ungrounded_figures(answer: AgentAnswer, tool_results: list[Any]) -> AgentAnswer:
    pool, by_hub = collect_numbers(tool_results), numbers_by_hub(tool_results)
    kept = [f for f in answer.figures if not _ungrounded(f, pool, by_hub)]
    return answer.model_copy(update={"figures": kept})
