"""Deterministic grounding check for the agent's final answer.

Every number the user sees must come from a tool result. The check runs in code after
the LLM's structured answer is parsed, so it does not depend on the model's honesty.
"""

from __future__ import annotations

import re
from collections import defaultdict
from typing import Any

from app.schemas import AgentAnswer, Figure

# A number with optional thousands commas, decimals, a trailing % and a compact suffix.
# A leading minus counts only when it is not glued to a word or a digit
# ("-10 °C" is negative; "2015-2025" and "top-3" are not). Suffixes: "472K", "2.6M", "1.2bn"
# (glued letters, so "60 km/h" is not 60,000) and "2.6 million" (words).
_NUMBER = re.compile(
    r"(?<![\w.,])(?P<sign>[-−]?)(?P<whole>\d{1,3}(?:,\d{3})+|\d+)(?P<frac>\.\d+)?(?P<pct>%?)"
    r"(?:(?P<letter>K|k|M|B|bn)\b|\s(?P<word>thousand|million|billion)\b)?"
)
_MULTIPLIER = {"k": 1e3, "thousand": 1e3, "m": 1e6, "million": 1e6, "b": 1e9, "bn": 1e9, "billion": 1e9}
# ISO dates and timestamps ("data as of 2026-11-17") are not figures.
_ISO_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b")


def _parse(match: re.Match[str]) -> float:
    """The number as written, without its suffix ("2.6M" -> 2.6)."""
    value = float(match["whole"].replace(",", "") + (match["frac"] or ""))
    return -value if match["sign"] else value


def _multiplier(match: re.Match[str]) -> float | None:
    suffix = match["letter"] or match["word"]
    return _MULTIPLIER[suffix.lower()] if suffix else None


def _compact_matches(match: re.Match[str], tool_value: float) -> bool:
    """A compact number matches a tool value that rounds to it at the displayed precision.

    "472K" covers 471,500-472,500 and "2.6M" covers 2.55M-2.65M (half a unit of the last shown digit).
    One significant digit ("1 million", "3M") is too coarse to verify, so it must round exactly.
    """
    mult = _multiplier(match)
    displayed = _parse(match) * mult
    digits = (match["whole"].replace(",", "") + (match["frac"] or "").lstrip(".")).lstrip("0")
    if len(digits) < 2:
        return abs(tool_value - displayed) <= 0.5
    decimals = len(match["frac"]) - 1 if match["frac"] else 0
    return abs(tool_value - displayed) <= 0.5 * 10 ** -decimals * mult * (1 + 1e-9)


def _text_number_found(match: re.Match[str], figure_values: list[float]) -> bool:
    # The plain mantissa still counts, as before: "$40M" cites a what_if cost of 40 (USD millions).
    if _found(_parse(match), figure_values):
        return True
    return _multiplier(match) is not None and any(_compact_matches(match, v) for v in figure_values)


def numbers_in_text(text: str) -> list[float]:
    return [_parse(m) for m in _NUMBER.finditer(text)]


def _is_exempt(match: re.Match[str]) -> bool:
    """Years and small counts ("top 3", "15 hubs", "2025") need no figure. "3M" is not a small count."""
    if match["sign"] or match["frac"] or match["pct"] or "," in match["whole"] or _multiplier(match):
        return False
    n = int(match["whole"])
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
            if _is_exempt(m) or _text_number_found(m, figure_values):
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


def cites_compact(text: str, value: float) -> bool:
    """True if the text writes `value` in compact form ("2.6M") that grounding would accept."""
    return any(_multiplier(m) is not None and _compact_matches(m, value)
               for m in _NUMBER.finditer(_ISO_DATE.sub(" ", text)))
