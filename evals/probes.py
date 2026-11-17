"""Offline grounding probes: adversarial figures against real tool output, no model call.

Each probe builds an AgentAnswer by hand, cites a number from a real `run_tool` result on the
committed snapshot, and states whether grounding must accept or reject it. The expected values
come from the tool result itself (an oracle), never from this file.
Run alone with `uv run python -m evals.probes`; `evals.run` runs them first and reports them.
"""

from __future__ import annotations

import asyncio
import json
import sys
from dataclasses import dataclass
from typing import Any

from app import grounding, tools
from app.schemas import AgentAnswer, Figure


@dataclass
class Probe:
    id: str
    about: str
    must_pass: bool
    figure: dict[str, Any]
    text: str
    known_limit: bool = False  # documents a gap; not counted as OK


def _answer(text: str, figure: Figure) -> AgentAnswer:
    return AgentAnswer(answer=text, hubs=[figure.hub_id] if figure.hub_id else [], ranking=None, figures=[figure],
                       assumptions=[], uncertainty="", data_available=True, in_scope=True, )


async def _results() -> dict[str, Any]:
    miami = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": "miami"}))
    houston = await tools.run_tool("get_hub_risk", json.dumps({"hub_id": "houston"}))
    return {"miami": miami, "houston": houston}


def probes(r: dict[str, Any]) -> list[Probe]:
    m, h = r["miami"], r["houston"]
    fig = dict(hub_id="miami", unit="", source_tool="get_hub_risk", family=None)
    return [
        Probe("adversarial_priority_as_hurricane_probability",
              "A 'hurricane probability' figure carrying Miami's priority value (the reproduced attack)",
              False, {**fig, "label": "hurricane probability", "value": m["priority"],
                      "source_field": "hurricane_10yr_probability_pct"},
              f"Miami's 10-year hurricane probability is {m['priority']}%."),
        Probe("priority_under_a_family",
              "Miami's priority cited as if it sat under families.hurricane",
              False, {**fig, "label": "hurricane priority", "value": m["priority"], "source_field": "priority",
                      "family": "hurricane"},
              f"Miami's hurricane priority is {m['priority']}."),
        Probe("other_hubs_value",
              "Houston's priority cited as Miami's",
              False, {**fig, "label": "priority", "value": h["priority"], "source_field": "priority"},
              f"Miami's priority is {h['priority']}."),
        Probe("wrong_family",
              "Miami's flood days per year cited as its hurricane days per year",
              False, {**fig, "label": "hurricane days per year", "value": m["families"]["flood"]["days_per_year"],
                      "source_field": "days_per_year", "family": "hurricane"},
              f"Miami loses {m['families']['flood']['days_per_year']} days a year to hurricanes."),
        Probe("known_limit_label_not_checked",
              "Known limit: a 'hurricane probability' label on Miami's priority, citing the priority field. "
              "Grounding binds the number to its field, not to the label or the prose around it",
              True, {**fig, "label": "hurricane probability", "value": m["priority"], "source_field": "priority"},
              f"Miami's 10-year hurricane probability is {m['priority']}%.", known_limit=True),
        Probe("control_hurricane_probability",
              "Control: the real hurricane probability at its own field",
              True, {**fig, "label": "hurricane probability", "value": m["hurricane_10yr_probability_pct"],
                     "source_field": "hurricane_10yr_probability_pct"},
              f"Miami's 10-year hurricane probability is {m['hurricane_10yr_probability_pct']}%."),
        Probe("control_family_days",
              "Control: hurricane days per year at families.hurricane.days_per_year",
              True, {**fig, "label": "hurricane days per year", "value": m["families"]["hurricane"]["days_per_year"],
                     "source_field": "days_per_year", "family": "hurricane"},
              f"Miami loses {m['families']['hurricane']['days_per_year']} days a year to hurricanes."),
    ]


def run_probes() -> list[dict[str, Any]]:
    return asyncio.run(run_probes_async())


async def run_probes_async() -> list[dict[str, Any]]:
    results = await _results()
    outputs = [grounding.ToolOutput("get_hub_risk", results["miami"]),
               grounding.ToolOutput("get_hub_risk", results["houston"])]
    out = []
    for p in probes(results):
        errors = grounding.check(_answer(p.text, Figure(**p.figure)), outputs, None)
        passed_grounding = not errors
        out.append({"id": p.id, "about": p.about, "must_pass": p.must_pass, "grounding_passed": passed_grounding,
                    "ok": passed_grounding == p.must_pass, "known_limit": p.known_limit,
                    "error": errors[0] if errors else ""})
    return out


def report(rows: list[dict[str, Any]]) -> str:
    counted = [r for r in rows if not r["known_limit"]]
    ok = sum(r["ok"] for r in counted)
    lines = [
        "## Offline grounding probes",
        "",
        f"{ok}/{len(counted)} as expected. Hand-built figures against real tool output (no model call): "
        "mis-cited numbers must be rejected, correct citations accepted.",
        "",
        "| Probe | Grounding must | Grounding did | OK |",
        "|---|---|---|---|",
    ]
    for r in rows:
        lines.append(f"| {r['id']}: {r['about']} | {'accept' if r['must_pass'] else 'reject'} | "
                     f"{'accept' if r['grounding_passed'] else 'reject'} | {'known limit' if r['known_limit'] else ('yes' if r['ok'] else '**NO**')} |")
    return "\n".join(lines + [""])


if __name__ == "__main__":
    rows = run_probes()
    print(report(rows))
    sys.exit(0 if all(r["ok"] for r in rows if not r["known_limit"]) else 1)
