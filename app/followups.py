"""Suggested follow-up questions, built by code from what happened in the turn.

The model does not write these: each suggestion is a template over the answer's hubs, its ranking and
the tools that ran, so every one is in scope and answerable, and none carries a number that would need
verifying.
"""

from __future__ import annotations

from functools import lru_cache

from app.schemas import AgentAnswer

MAX_SUGGESTIONS = 3

STARTERS = [
    "Which hubs are most exposed to weather disruption?",
    "Which Midwest hubs are most exposed to winter disruption?",
    "Compare Miami and Houston in terms of hurricane and flood exposure.",
]


@lru_cache(maxsize=1)
def _hub_names() -> dict[str, str]:
    from app.scoring import load_hubs

    return {h.id: h.city for h in load_hubs()}


def _possessive(name: str) -> str:
    return f"{name}'s"


def suggest_follow_ups(
    answer: AgentAnswer,
    tool_names: list[str],
    names: dict[str, str] | None = None,
    *,
    user_message: str = "",
    used_bad_year: bool = False,
) -> list[str]:
    """Up to three follow-up questions for the UI to offer as one-click chips."""
    names = names if names is not None else _hub_names()

    def name(hub_id: str) -> str:
        return names.get(hub_id, hub_id)

    if not answer.in_scope or not answer.data_available:
        candidates = list(STARTERS)
    elif answer.ranking and len(answer.ranking) >= 2:
        top, second = name(answer.ranking[0]), name(answer.ranking[1])
        candidates = [
            f"Why is {top} ranked first?",
            # after a comparison, "Compare A and B" would repeat the question just answered
            f"What drives {_possessive(second)} risk?" if "compare_hubs" in tool_names and len(answer.ranking) == 2
            else f"Compare {top} and {second}",
            "Show the typical-year ranking" if used_bad_year else "Show the bad-year ranking",
        ]
    elif len(answer.hubs) == 1:
        hub = name(answer.hubs[0])
        candidates = [f"What upgrades would reduce {_possessive(hub)} weather risk?"]
        if "get_active_alerts" not in tool_names:
            candidates.append(f"Are there active weather alerts at {hub}?")
        candidates.append(f"Where does {hub} rank among all hubs?")
    elif len(answer.hubs) >= 2:
        a, b = name(answer.hubs[0]), name(answer.hubs[1])
        candidates = [f"What drives {_possessive(a)} risk?", f"What drives {_possessive(b)} risk?", "Which of them has the worse bad year?"]
    else:
        candidates = list(STARTERS)

    asked = user_message.strip().lower().rstrip("?. ")
    out: list[str] = []
    for c in candidates:
        if c.strip().lower().rstrip("?. ") != asked and c not in out:
            out.append(c)
    return out[:MAX_SUGGESTIONS]
