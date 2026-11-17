"""Two fake tools with the same registry shape as app.tools (TOOL_FUNCTIONS, ARG_MODELS, run_tool).

Used by Track B tests until app.tools lands, and afterwards to keep agent tests
independent of the real scoring numbers.
"""

from __future__ import annotations

import ai
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.schemas import AgentAnswer, Figure, ScoreKind, ToolError

THRESHOLDS = {"medium_from": 35.0, "high_from": 60.0}
HUBS = {
    "houston": {"exposure": 66.0, "exposure_band": "high", "priority": 58.2, "priority_band": "medium", "top_driver": "hurricane"},
    "dallas": {"exposure": 41.7, "exposure_band": "medium", "priority": 44.9, "priority_band": "medium", "top_driver": "severe_storm"},
    "miami": {"exposure": 71.2, "exposure_band": "high", "priority": 63.5, "priority_band": "high", "top_driver": "hurricane"},
}


class GetHubRiskArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    hub_id: str


class RankHubsArgs(BaseModel):
    model_config = ConfigDict(extra="forbid")
    score: ScoreKind
    top_n: int = Field(ge=1, le=15)


def hub_risk(hub_id: str) -> dict:
    if hub_id not in HUBS:
        return ToolError(
            error=f"Unknown hub '{hub_id}'.", retryable=False, hint=f"Valid hub ids: {', '.join(sorted(HUBS))}."
        ).model_dump()
    return {"hub_id": hub_id, **HUBS[hub_id], "band_thresholds": THRESHOLDS, "data_as_of": "2026-11-17"}


async def get_hub_risk(hub_id: str) -> dict:
    """Return both scores, bands and the top driver for one hub. Use list_hubs to map city names to hub ids."""
    return hub_risk(hub_id)


async def rank_hubs(score: ScoreKind, top_n: int) -> dict:
    """Rank hubs by exposure or priority, highest first."""
    ordered = sorted(HUBS, key=lambda h: (-HUBS[h][score], h))[:top_n]
    return {
        "kind": score,
        "hazard": "overall",
        "region": None,
        "items": [
            {"rank": i + 1, "hub_id": h, "name": h.title(), "value": HUBS[h][score], "band": HUBS[h][f"{score}_band"]}
            for i, h in enumerate(ordered)
        ],
        "band_thresholds": THRESHOLDS,
        "data_as_of": "2026-11-17",
    }


TOOL_FUNCTIONS = [get_hub_risk, rank_hubs]
ARG_MODELS: dict[str, type[BaseModel]] = {"get_hub_risk": GetHubRiskArgs, "rank_hubs": RankHubsArgs}


async def run_tool(name: str, arguments_json: str) -> dict:
    fns = {f.__name__: f for f in TOOL_FUNCTIONS}
    if name not in fns:
        return ToolError(error=f"Unknown tool '{name}'.", retryable=False, hint="Use one of the listed tools.").model_dump()
    try:
        args = ARG_MODELS[name].model_validate_json(arguments_json)
    except ValidationError as exc:
        return ToolError(error="Invalid arguments.", retryable=True, hint=str(exc)).model_dump()
    return await fns[name](**args.model_dump())


# ---------- script helpers ----------


def _figure(hub: str | None, label: str, value: float, field: str | None = None, tool: str = "get_hub_risk", family: str | None = None) -> Figure:
    """A scripted figure; the source field defaults to the label ("exposure", "priority")."""
    return Figure(
        hub_id=hub, label=label, value=value, unit="score 0-100", source_tool=tool, source_field=field or label, family=family
    )


def answer_json(
    text: str = "Houston exposure is 66.",
    figures: list[tuple] | None = None,
    *,
    hubs: list[str] | None = None,
    ranking: list[str] | None = None,
    data_available: bool = True,
    in_scope: bool = True,
) -> str:
    figs = figures if figures is not None else [("houston", "exposure", 66.0)]
    return AgentAnswer(
        answer=text,
        hubs=hubs if hubs is not None else ["houston"],
        ranking=ranking,
        figures=[_figure(*f) for f in figs],
        assumptions=[],
        uncertainty="Scores use the committed snapshot.",
        data_available=data_available,
        in_scope=in_scope,
    ).model_dump_json()


def call(name: str, **kwargs) -> ai.messages.ToolCallPart:
    return ai.testing.tool_call(name, **kwargs)


def tool_msg(part: ai.messages.ToolCallPart, result: dict) -> ai.messages.Message:
    return ai.tool_message(
        ai.messages.ToolResultPart(
            tool_call_id=part.tool_call_id,
            tool_name=part.tool_name,
            result=result,
            result_kind=ai.messages.ToolResultPart.kind_for(result),
        )
    )
