"""Deterministic grounding check for the agent's final answer.

Every number the user sees must come from a tool result. The check runs in code after
the LLM's structured answer is parsed, so it does not depend on the model's honesty.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, NamedTuple, get_args

from app.schemas import AgentAnswer, Family, Figure

FAMILIES = frozenset(get_args(Family))


class ToolOutput(NamedTuple):
    """One tool result and the name of the tool that returned it."""

    tool: str
    result: Any

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
# Names with digits joined by hyphens ("gpt-6.1-sol", "v2-tvar", "I-35") are identifiers, not figures.
_IDENTIFIER = re.compile(r"\b[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9.]*[A-Za-z0-9])+")


_SCALE = re.compile(r"\b0\s*(?:-|to)\s*100\b")  # "a 0-100 index" names the scale, it is not a figure


def _strip_identifiers(text: str) -> str:
    text = _SCALE.sub(" ", text)
    return _IDENTIFIER.sub(lambda m: " " if any(c.isdigit() for c in m.group(0)) else m.group(0), text)


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


@dataclass(frozen=True)
class Leaf:
    """A citable number in a tool result, with where it sits."""

    hub: str | None  # hub_id of the nearest enclosing object that has one
    family: str | None  # under families.<family>, or the key of a family-keyed dict (days.<family>)
    field: str  # the key holding the number (for a family-keyed dict, the dict's own key)
    value: float
    in_thresholds: bool  # inside band_thresholds


def leaves(result: Any) -> list[Leaf]:
    """Every number in one tool result with its hub, family and field.

    ToolError results and ISO dates are skipped; numbers written in strings count for that string's field.
    """
    out: list[Leaf] = []

    def visit(obj: Any, field: str | None, hub: str | None, family: str | None, in_bt: bool) -> None:
        if isinstance(obj, bool) or obj is None:
            return
        if isinstance(obj, (int, float)):
            if field is not None:
                out.append(Leaf(hub, family, field, float(obj), in_bt))
        elif isinstance(obj, str):
            if field is not None:
                out.extend(Leaf(hub, family, field, v, in_bt) for v in numbers_in_text(_ISO_DATE.sub(" ", obj)))
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                visit(item, field, hub, family, in_bt)
        elif isinstance(obj, dict):
            if _is_tool_error(obj):
                return
            if isinstance(obj.get("hub_id"), str):
                hub = obj["hub_id"]
            for key, value in obj.items():
                if not isinstance(key, str):
                    continue
                if key in FAMILIES:
                    # families.<family>.<field>, or a family-keyed dict such as days.<family> / family_weights.<family>
                    visit(value, None if isinstance(value, (dict, list)) else field, hub, key, in_bt)
                else:
                    visit(value, key, hub, family, in_bt or key == "band_thresholds")

    visit(result, None, None, None, False)
    return out


def _as_output(item: Any) -> ToolOutput:
    if isinstance(item, ToolOutput):
        return item
    if isinstance(item, tuple) and len(item) == 2 and isinstance(item[0], str):
        return ToolOutput(*item)
    return ToolOutput("", item)  # unnamed: no figure can cite it


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


def _bound_values(f: Figure, indexed: list[tuple[str, list[Leaf]]]) -> list[float] | None:
    """Values at the figure's tool / hub / family / field; None if no result of that tool exists."""
    found: list[float] | None = None
    for tool, items in indexed:
        if tool != f.source_tool:
            continue
        found = found or []
        for leaf in items:
            if leaf.field != f.source_field or leaf.family != f.family:
                continue
            # A hub's figure must sit in an object about that hub; a general figure (hub_id null) in a
            # hub-less part of the result or in band_thresholds.
            if (leaf.hub == f.hub_id) if f.hub_id is not None else (leaf.hub is None or leaf.in_thresholds):
                found.append(leaf.value)
    return found


def _figure_error(f: Figure, values: list[float] | None) -> str | None:
    if values and _found(f.value, values):
        return None
    where = f"{f.source_tool}.{f.source_field}" + (f" (family {f.family})" if f.family else "")
    who = f"hub {f.hub_id}" if f.hub_id else "a general figure (hub_id null)"
    if values is None:
        return (
            f"Figure '{f.label}' (value {_fmt(f.value)}) cites tool {f.source_tool}, but no {f.source_tool} result exists "
            "in this conversation. Set source_tool to the tool that returned the number."
        )
    if not values:
        return (
            f"Figure '{f.label}' (value {_fmt(f.value)}) cites {where} for {who}, but that result has no such field there. "
            "Set source_field to the exact field name in the tool result, family when it sits under families.<family>, "
            "and hub_id to the hub whose object holds it (null only for band_thresholds and hub-less fields)."
        )
    shown = ", ".join(_fmt(v) for v in sorted(set(values))[:5])
    return (
        f"Figure '{f.label}' cites {where} for {who} as {_fmt(f.value)}, but that field is {shown}. "
        "Copy the value of the field you cite, or cite the field that holds your number."
    )


def check(answer: AgentAnswer, tool_results: list[Any], expected_ranking: list[str] | None) -> list[str]:
    """Return grounding errors; an empty list means the answer is grounded.

    tool_results are ToolOutput(tool, result) pairs (this turn and prior turns). A figure passes only
    if a result of its source_tool holds, for its hub_id and family, the field source_field with a
    matching value. Every number in the answer text, assumptions and uncertainty must be a figure.

    expected_ranking=None derives the allowed orders from the tool results. A ranking may be
    any subset of the order the code returned (top N, a filtered list) or that order reversed
    (lowest first).
    """
    errors: list[str] = []
    outputs = [_as_output(item) for item in tool_results]
    indexed = [(o.tool, leaves(o.result)) for o in outputs]
    if not answer.data_available and answer.figures:
        errors.append(
            "A no-data answer (data_available false) must not cite figures. Remove the figures and the numbers "
            "from the text, or set data_available true if the tools did return what was asked."
        )
    for f in answer.figures:
        error = _figure_error(f, _bound_values(f, indexed))
        if error:
            errors.append(error)

    figure_values = [f.value for f in answer.figures]
    for field, text in _text_fields(answer):
        for m in _NUMBER.finditer(_strip_identifiers(_ISO_DATE.sub(" ", text))):
            if _is_exempt(m) or _text_number_found(m, figure_values):
                continue
            errors.append(f"The {field} text mentions {m.group(0)}, which is not in figures. Add it to figures or remove it.")

    if answer.ranking:
        candidates = [expected_ranking] if expected_ranking is not None else ranking_candidates([o.result for o in outputs])
        if not candidates:
            errors.append("The answer has a ranking but no tool returned a ranking. Call rank_hubs or set ranking to null.")
        elif not any(_in_order(answer.ranking, c) or _in_order(answer.ranking, c[::-1]) for c in candidates):
            errors.append(
                f"The ranking {answer.ranking} does not match the order the tools returned ({candidates[-1]}). "
                "Copy the order from the tool result."
            )
    return errors


def drop_ungrounded_figures(answer: AgentAnswer, tool_results: list[Any]) -> AgentAnswer:
    indexed = [(o.tool, leaves(o.result)) for o in map(_as_output, tool_results)]
    kept = [f for f in answer.figures if answer.data_available and _figure_error(f, _bound_values(f, indexed)) is None]
    return answer.model_copy(update={"figures": kept})


def cites_compact(text: str, value: float) -> bool:
    """True if the text writes `value` in compact form ("2.6M") that grounding would accept."""
    return any(_multiplier(m) is not None and _compact_matches(m, value)
               for m in _NUMBER.finditer(_ISO_DATE.sub(" ", text)))
