"""Eval runner: `uv run python -m evals.run` (or `make eval`).

Runs every case in `evals/cases.yaml` against the real model through `app.agent.run_turn`
(the same function `/chat/json` uses), a few cases at a time. Expected values come from
`app.scoring` at run time (the oracle), never from the YAML. Stores and traces of the run go
to a temp directory, not the repo. Writes a per-case table and aggregates to stdout and to
`evals/results/latest.md`, keeping any "## Failure analysis" section already in that file.

Options: --only id1,id2 (targeted rerun; writes to the temp dir unless --out is given),
--concurrency N (default 3), --no-judge, --out PATH.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import math
import os
import re
import tempfile
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from dotenv import load_dotenv

REPO = Path(__file__).resolve().parents[1]
CASES_PATH = REPO / "evals" / "cases.yaml"
LATEST = REPO / "evals" / "results" / "latest.md"
ANALYSIS_HEADING = "## Failure analysis"
MAX_TOOL_ROUNDS = 6
# "one" to "ten" are normal prose ("two hubs"); larger number words in an answer hide a number from grounding.
SPELLED_NUMBER = re.compile(
    r"\b(eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|seventeenth|eighteen|nineteen|"
    r"twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b",
    re.IGNORECASE,
)
NEGATION = re.compile(
    r"\b(not|no|never|cannot|can't|can’t|won't|won’t|isn't|isn’t|don't|don’t|doesn't|doesn’t|ignore|instead|rather|asked|request|unable|override)\b",
    re.IGNORECASE,
)


# ---------- oracle: expected values from the scoring code ----------


class Oracle:
    def __init__(self) -> None:
        from app import scoring

        self.scoring = scoring
        self.hubs = scoring.load_hubs()
        self.snapshot = scoring.load_snapshot()
        self.scores = scoring.score_all(self.hubs, self.snapshot)
        self.by_id = {h.id: h for h in self.hubs}

    def ranking(self, spec: dict[str, Any]) -> list[str]:
        if "what_if" in spec:
            from app.schemas import WhatIfInput

            result = self.scoring.what_if(self.hubs, self.snapshot, WhatIfInput.model_validate(spec["what_if"]))
            rows = getattr(result, spec.get("list", "ranking")) or []
            return [r.hub_id for r in rows]
        ranking = self.scoring.rank(
            self.scores, self.hubs, spec["kind"], hazard=spec.get("hazard", "overall"),
            region=spec.get("region"), top_n=spec.get("top_n", 15),
        )
        return [i.hub_id for i in ranking.items]

    def weather(self, spec: dict[str, Any]) -> float:
        return self.scoring.weather_stat(self.snapshot, spec["hub_id"], spec["metric"], spec["year"]).value

    def band(self, hub_id: str, kind: str) -> str:
        s = self.scores[hub_id]
        return s.exposure_band if kind == "exposure" else s.priority_band

    def history(self, hub_id: str):
        return self.scoring.hub_history(self.hubs, self.snapshot, hub_id)

    def signal_raw(self, hub_id: str, prefix: str) -> float:
        """Raw value of a priority signal, e.g. 'people served' (county population)."""
        return next(s.raw for s in self.scores[hub_id].priority_signals if s.name.startswith(prefix))

    def score_values(self, spec: dict[str, Any]) -> list[float]:
        """Values a correct answer may cite: a family's index, share (%) or days per year, or a score."""
        s = self.scores[spec["hub_id"]]
        if "family" in spec:
            fam = s.families[spec["family"]]
            return [fam.score, s.family_weights[spec["family"]], fam.days_per_year, fam.bad_year_days]
        if spec["score"] == "exposure":
            return [s.exposure, s.exposure_days_per_year]
        if spec["score"] == "bad_year":
            return [s.bad_year_days]
        return [s.priority]

    def top_driver(self, hub_id: str, lens: str = "typical") -> tuple[str, float]:
        """(family, share %) of the typical year (top_driver) or of the bad year (largest family bad_year_days)."""
        s = self.scores[hub_id]
        if lens == "bad_year":
            fam = max(s.families, key=lambda f: (s.families[f].bad_year_days, f))
            return fam, round(100 * s.families[fam].bad_year_days / s.bad_year_days, 1)
        return s.top_driver, s.family_weights[s.top_driver]

    def judge_hub(self, spec: dict[str, Any]) -> str:
        return spec["hub_id"] if "hub_id" in spec else self.ranking(spec["hub_from"])[0]

    def names(self, hub_id: str) -> list[str]:
        h = self.by_id[hub_id]
        return [h.city, h.name, h.id.replace("_", " ")]


# ---------- running ----------


@dataclass
class Turn:
    message: str
    latency_s: float = 0.0
    response: Any = None  # ChatResponse
    error: str | None = None


@dataclass
class Run:
    case_id: str
    repeat: int
    turns: list[Turn] = field(default_factory=list)
    checks: list[tuple[str, bool, str]] = field(default_factory=list)
    tools_called: list[str] = field(default_factory=list)
    tool_args: list[tuple[str, dict]] = field(default_factory=list)
    tool_rounds: int | None = None
    tokens_in: int = 0
    tokens_out: int = 0
    cost_usd: float = 0.0
    judge: dict[str, Any] | None = None

    @property
    def last(self) -> Turn:
        return self.turns[-1]

    @property
    def passed(self) -> bool:
        return all(ok for _, ok, _ in self.checks)


async def run_case(case: dict, repeat: int, model, store, tracer, sem: asyncio.Semaphore) -> Run:
    from app.agent import run_turn

    run = Run(case_id=case["id"], repeat=repeat)
    async with sem:
        session_id = None
        for message in case["turns"]:
            turn = Turn(message=message)
            run.turns.append(turn)
            start = time.perf_counter()
            try:
                turn.response = await run_turn(message, session_id, model=model, store=store, tracer=tracer)
                session_id = turn.response.session_id
            except BaseException as exc:  # noqa: BLE001 - a crash is a failed case, not a crashed runner
                while isinstance(exc, BaseExceptionGroup) and exc.exceptions:
                    exc = exc.exceptions[0]
                turn.error = f"{type(exc).__name__}: {exc}"[:300]
            turn.latency_s = round(time.perf_counter() - start, 2)
            if turn.error:
                break
    print(f"  done {run.case_id}#{repeat + 1} in {sum(t.latency_s for t in run.turns):.1f}s", flush=True)
    return run


def load_traces(path: Path) -> dict[str, list[dict]]:
    by_trace: dict[str, list[dict]] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            event = json.loads(line)
            by_trace.setdefault(event["trace_id"], []).append(event)
    return by_trace


def attach_trace_data(run: Run, traces: dict[str, list[dict]]) -> None:
    for i, turn in enumerate(run.turns):
        if turn.response is None:
            continue
        events = traces.get(turn.response.trace_id, [])
        for e in events:
            if e["kind"] == "turn_end":
                run.tokens_in += e.get("input_tokens") or 0
                run.tokens_out += e.get("output_tokens") or 0
                run.cost_usd += e.get("cost_usd") or 0.0
            if i == len(run.turns) - 1:
                if e["kind"] == "tool_call":
                    run.tools_called.append(e["name"])
                    run.tool_args.append((e["name"], e.get("args") or {}))
                elif e["kind"] == "grounding":
                    run.tool_rounds = e.get("tool_rounds")


# ---------- checks ----------


def _ranking_ok(answer_ranking: list[str] | None, expected: list[str]) -> bool:
    return bool(answer_ranking) and answer_ranking == expected[: len(answer_ranking)]


def check_run(run: Run, case: dict, oracle: Oracle) -> None:
    from app.grounding import matches, numbers_in_text

    expect = case.get("expect", {})
    add = run.checks.append
    if run.last.error or run.last.response is None:
        add(("completed", False, run.last.error or "no response"))
        return
    resp = run.last.response
    answer = resp.answer
    text = answer.answer
    called = set(run.tools_called)

    tool_problems = []
    for req in expect.get("tools_required", []):
        if not called & set(req.split("|")):
            tool_problems.append(f"missing {req}")
    forbidden = expect.get("tools_forbidden", [])
    if "*" in forbidden and called:
        tool_problems.append(f"no tools expected, called {sorted(called)}")
    for name in forbidden:
        if name != "*" and name in called:
            tool_problems.append(f"forbidden {name}")
    if "tools_required" in expect or "tools_forbidden" in expect:
        add(("tools", not tool_problems, "; ".join(tool_problems)))

    for spec in expect.get("tool_args", []):
        calls = [a for name, a in run.tool_args if name == spec["tool"]]
        ok = any(
            all(a.get(k) == v for k, v in spec.get("equals", {}).items())
            and all(isinstance(a.get(k), (int, float)) and a[k] >= v for k, v in spec.get("min", {}).items())
            for a in calls
        )
        add(("tool_args", ok, "" if ok else f"no {spec['tool']} call with {spec}; calls: {calls}"))

    if "ranking_from" in expect:
        specs = expect["ranking_from"] if isinstance(expect["ranking_from"], list) else [expect["ranking_from"]]
        expected = [oracle.ranking(s) for s in specs]
        if answer.ranking is None and not expect.get("ranking_required", True):
            pass
        else:
            if expect.get("ranking_exact"):
                ok = any(answer.ranking == e for e in expected)
            else:
                ok = any(_ranking_ok(answer.ranking, e) for e in expected)
            add(("ranking", ok, "" if ok else f"got {answer.ranking}, oracle {expected[0][:5]}..."))

    if "figure" in expect:
        spec = expect["figure"]
        value = oracle.weather(spec)
        in_figures = any(f.hub_id == spec["hub_id"] and matches(f.value, value) for f in answer.figures)
        in_text = any(matches(n, value) for n in numbers_in_text(text))
        add(("figure", in_figures and in_text,
             "" if in_figures and in_text else f"expected {value} for {spec['hub_id']} (figures: {in_figures}, text: {in_text})"))

    for hub_id in expect.get("hubs_include", []):
        add(("hubs", hub_id in answer.hubs, "" if hub_id in answer.hubs else f"{hub_id} not in answer.hubs {answer.hubs}"))

    for spec in expect.get("score_figures", []):
        values = oracle.score_values(spec)
        ok = any(f.hub_id == spec["hub_id"] and any(matches(f.value, v) for v in values) for f in answer.figures)
        what = spec.get("family") or spec.get("score")
        add(("score_figure", ok, "" if ok else f"no figure for {spec['hub_id']} {what} matching the code values {values}"))

    if "history" in expect:
        import calendar

        hist = oracle.history(expect["history"]["hub_id"])
        missing = [calendar.month_name[mo] for mo in hist.peak_months
                   if not re.search(rf"\b({calendar.month_name[mo]}|{calendar.month_abbr[mo]})\b", text)]
        has_year = re.search(rf"\b{hist.worst_year}\b", text) is not None
        ok = not missing and has_year
        add(("history", ok, "" if ok else f"oracle peak months {hist.peak_months}, worst year {hist.worst_year}; "
                                          f"missing months {missing}, worst year named: {has_year}"))

    if "compact_figure" in expect:
        from app.grounding import cites_compact

        spec = expect["compact_figure"]
        value = oracle.signal_raw(spec["hub_id"], spec["signal"])
        exact = any(f.hub_id == spec["hub_id"] and f.value == value for f in answer.figures)
        compact = cites_compact(text, value)
        add(("compact_figure", exact and compact,
             "" if exact and compact else f"{value:,.0f}: exact in figures {exact}, compact in text {compact}"))

    if expect.get("grounding_first_try"):
        add(("grounding_first_try", resp.grounding.status == "pass", f"status {resp.grounding.status}"))

    if "states_band" in expect:
        spec = expect["states_band"]
        band = oracle.band(spec["hub_id"], spec["kind"])
        ok = re.search(rf"\b{band}\b", text, re.IGNORECASE) is not None
        add(("band", ok, "" if ok else f"answer does not state the code band '{band}'"))

    if "mentions_top_of" in expect:
        tops = [oracle.ranking(s)[0] for s in expect["mentions_top_of"]]
        ok = any(re.search(re.escape(n), text, re.IGNORECASE) for t in tops for n in oracle.names(t))
        add(("top_hub", ok, "" if ok else f"answer names none of {tops}"))

    full_text = "\n".join([text, *answer.assumptions])
    for pattern in expect.get("text_must_match", []):
        ok = re.search(pattern, full_text) is not None
        add(("text", ok, "" if ok else f"no match for {pattern}"))

    for pattern in expect.get("claims_absent", []):
        sentences = [s for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]
        bad = [s for s in sentences if re.search(pattern, s, re.IGNORECASE) and not NEGATION.search(s)]
        add(("no_false_claim", not bad, "" if not bad else f"claims: {bad[0][:120]}"))

    if expect.get("no_closing_question"):
        ends_with_q = text.rstrip().rstrip("*_ ").endswith("?")
        add(("no_closing_question", not ends_with_q, "" if not ends_with_q else "answer ends the turn with a question"))

    # Rule: a no-data answer cites no figures (and so no numbers).
    if answer.data_available is False:
        add(("no_data_no_figures", not answer.figures,
             "" if not answer.figures else f"data_available false but {len(answer.figures)} figures"))

    for key in ("in_scope", "data_available"):
        if key in expect:
            got = getattr(answer, key)
            add((key, got == expect[key], "" if got == expect[key] else f"{key}={got}, expected {expect[key]}"))

    # Numbers spelled out in words ("twenty twenty-five") would slip past the grounding regex.
    spelled = SPELLED_NUMBER.findall("\n".join([full_text, answer.uncertainty]))
    add(("digits_only", not spelled, "" if not spelled else f"spelled-out numbers: {sorted(set(w.lower() for w in spelled))}"))

    # The UI draws the figures table and charts from tool outputs; a table in the answer duplicates them.
    has_table = re.search(r"^\s*\|.*\|\s*$", text, re.MULTILINE) is not None
    add(("no_table", not has_table, "" if not has_table else "answer contains a markdown table"))

    add(("grounding", resp.grounding.status != "failed",
         "" if resp.grounding.status != "failed" else "; ".join(resp.grounding.errors)[:200]))
    rounds_ok = run.tool_rounds is not None and run.tool_rounds <= MAX_TOOL_ROUNDS
    add(("steps", rounds_ok, "" if rounds_ok else f"tool rounds {run.tool_rounds}"))


async def judge_run(run: Run, case: dict, oracle: Oracle, model, sem: asyncio.Semaphore) -> None:
    from evals.judge import judge_top_driver

    if not case.get("judge") or run.last.response is None:
        return
    hub_id = oracle.judge_hub(case["judge"])
    lens = case["judge"].get("lens", "typical")
    family, share = oracle.top_driver(hub_id, lens)
    async with sem:
        try:
            verdict = await judge_top_driver(model, run.last.response.answer.answer, oracle.by_id[hub_id].name,
                                             family, share, lens)
        except Exception as exc:  # noqa: BLE001
            verdict = {"passed": None, "reason": f"judge error: {type(exc).__name__}", "input_tokens": 0, "output_tokens": 0}
    verdict.update(hub_id=hub_id, family=family)
    run.judge = verdict
    ok = verdict["passed"] is True
    run.checks.append(("judge_top_driver", ok,
                       "" if ok else f"expected {family} ({lens}) for {hub_id}: {verdict['reason']}"))



# ---------- grounding breakdown (retries and failures: cited field vs the field that holds the number) ----------

_FIG_ERR = [
    re.compile(r"Figure '(?P<label>.+?)' \(value (?P<v>[-\d.e+]+)\) cites tool (?P<tool>\w+), but no (?P=tool) result"),
    re.compile(r"Figure '(?P<label>.+?)' \(value (?P<v>[-\d.e+]+)\) cites (?P<tool>\w+)\.(?P<field>\w+)"
               r"(?: \(family (?P<fam>\w+)\))? for (?P<who>hub \w+|a general figure \(hub_id null\)), but that result has no such field"),
    re.compile(r"Figure '(?P<label>.+?)' cites (?P<tool>\w+)\.(?P<field>\w+)(?: \(family (?P<fam>\w+)\))? "
               r"for (?P<who>hub \w+|a general figure \(hub_id null\)) as (?P<v>[-\d.e+]+), but that field is (?P<actual>.+?)\. Copy"),
]
_OFFLINE_TOOLS = {"list_hubs", "rank_hubs", "get_hub_risk", "compare_hubs", "weather_stat", "what_if", "get_hub_history"}


async def _replay(events: list[dict]) -> list:
    """Re-run a turn's deterministic tool calls offline to see which field holds a number."""
    from app import grounding, tools

    out = []
    for e in events:
        if e["kind"] == "tool_call" and e.get("name") in _OFFLINE_TOOLS and not e.get("error"):
            out.append(grounding.ToolOutput(e["name"], await tools.run_tool(e["name"], json.dumps(e.get("args") or {}))))
    return out


def _holders(value: float, hub: str | None, outputs: list) -> list[str]:
    from app.grounding import leaves, matches

    found = []
    for o in outputs:
        for leaf in leaves(o.result):
            if matches(value, leaf.value) and (hub is None or leaf.hub == hub):
                where = f"{o.tool}.{leaf.field}" + (f" [{leaf.family}]" if leaf.family else "") + (f" @{leaf.hub}" if leaf.hub and hub is None else "")
                if where not in found:
                    found.append(where)
    return found[:3]


def _describe(error: str, outputs: list) -> tuple[str, str, str]:
    """(kind, what the model cited, where the number really is)."""
    for rx in _FIG_ERR:
        m = rx.search(error)
        if not m:
            continue
        g = m.groupdict()
        hub = g.get("who", "hub ?")[4:] if (g.get("who") or "").startswith("hub ") else None
        cited = f"{g['tool']}.{g.get('field') or '?'}" + (f" [{g['fam']}]" if g.get("fam") else "") + f" @{hub or 'null'}"
        cited += f" = {g['v']}" if g.get("v") else ""
        holders = _holders(float(g["v"]), hub, outputs) if g.get("v") else []
        actual = f" (field holds {g['actual']})" if g.get("actual") else ""
        return "figure", f"'{g['label']}': {cited}{actual}", ", ".join(holders) or "no tool field holds it"
    if "not in figures" in error:
        return "text number", error.split(" text ")[-1][:90], "-"
    if "ranking" in error.lower():
        return "ranking", error[:90], "-"
    return "other", error[:90], "-"


async def grounding_breakdown(runs: list[Run], traces: dict[str, list[dict]]) -> str:
    counts = {"pass": 0, "retried": 0, "failed": 0, "error": 0}
    rows = []
    for r in runs:
        for i, turn in enumerate(r.turns):
            if turn.response is None:
                counts["error"] += 1
                continue
            status = turn.response.grounding.status
            counts[status] += 1
            if status == "pass":
                continue
            events = traces.get(turn.response.trace_id, [])
            g = next((e for e in events if e["kind"] == "grounding"), {})
            outputs = []
            for t in r.turns[: i + 1]:  # this turn and the earlier turns of the session (grounding sees both)
                outputs += await _replay(traces.get(t.response.trace_id, []) if t.response else [])
            attempts = [("first", g.get("first_errors") or [])]
            if status == "failed":
                attempts.append(("retry", turn.response.grounding.errors))
            for attempt, errors in attempts:
                for err in errors:
                    kind, cited, holder = _describe(err, outputs)
                    rows.append(f"| {r.case_id} t{i + 1} | {status} | {attempt} | {kind} | {cited.replace('|', '/')} | {holder} |")
    total = sum(counts.values())
    lines = [
        "## Grounding breakdown",
        "",
        f"Turns: {total}. First try: {counts['pass']}. Passed after one retry: {counts['retried']}. "
        f"Failed after the retry: {counts['failed']}. Turn errors: {counts['error']}.",
        "",
    ]
    if rows:
        lines += [
            "For each retried or failed turn, every grounding error: what the model cited (tool.field [family] @hub = value) "
            "and which field of that turn's tool results actually holds the number (tools re-run offline).",
            "",
            "| Case, turn | Status | Attempt | Error kind | Model cited | Field that holds the number |",
            "|---|---|---|---|---|---|",
            *rows,
        ]
    else:
        lines.append("No grounding errors in this run.")
    return "\n".join(lines + [""])


# ---------- report ----------


def _p95(values: list[float]) -> float:
    s = sorted(values)
    return s[max(0, math.ceil(0.95 * len(s)) - 1)] if s else 0.0


def build_report(cases: list[dict], runs: list[Run], meta: dict[str, Any]) -> str:
    from app.agent import _cost

    by_case: dict[str, list[Run]] = {}
    for r in runs:
        by_case.setdefault(r.case_id, []).append(r)

    rows = []
    case_pass = 0
    determinism: list[str] = []
    for case in cases:
        rs = by_case.get(case["id"], [])
        if not rs:
            continue
        failed = [f"{name}: {detail}" if detail else name
                  for r in rs for name, ok, detail in r.checks if not ok]
        if case.get("repeat", 1) > 1:
            rankings = [r.last.response.answer.ranking if r.last.response else None for r in rs]
            same = all(x is not None for x in rankings) and all(x == rankings[0] for x in rankings)
            determinism.append(f"{case['id']}: {len(rs)} runs, identical ranking: {'yes' if same else 'no'}")
            if not same:
                failed.append(f"determinism: rankings differ {rankings}")
        passed = not failed
        case_pass += passed
        tools = " / ".join(",".join(dict.fromkeys(r.tools_called)) or "-" for r in rs)
        grounding = "/".join(r.last.response.grounding.status if r.last.response else "error" for r in rs)
        judge = "/".join(("pass" if r.judge["passed"] else "fail") if r.judge else "-" for r in rs)
        latency = "/".join(f"{sum(t.latency_s for t in r.turns):.1f}" for r in rs)
        rows.append(f"| {case['id']} | {'PASS' if passed else 'FAIL'} | {tools} | {grounding} | {judge} | {latency} | "
                    f"{'; '.join(dict.fromkeys(failed)).replace('|', '/')[:300] or ''} |")

    turns = [t for r in runs for t in r.turns]
    statuses = [t.response.grounding.status if t.response else "error" for t in turns]
    tool_runs = [r for r in runs if any(n == "tools" for n, _, _ in r.checks)]
    tool_ok = sum(1 for r in tool_runs if all(ok for n, ok, _ in r.checks if n == "tools"))
    judged = [r for r in runs if r.judge]
    judge_ok = sum(1 for r in judged if r.judge["passed"])
    latencies = [t.latency_s for t in turns if t.response is not None]
    tokens_in = sum(r.tokens_in for r in runs)
    tokens_out = sum(r.tokens_out for r in runs)
    judge_in = sum(r.judge["input_tokens"] for r in judged)
    judge_out = sum(r.judge["output_tokens"] for r in judged)
    agent_cost = sum(r.cost_usd for r in runs)
    judge_cost = _cost(meta["model"], judge_in, judge_out) or 0.0
    n_cases = len(rows)

    def pct(a: int, b: int) -> str:
        return f"{a}/{b} ({100 * a / b:.0f}%)" if b else "n/a"

    lines = [
        "# Eval results",
        "",
        f"Run {meta['started']} UTC. Model `{meta['model']}`, reasoning effort `{meta['effort']}`, "
        f"snapshot data as of {meta['data_as_of']}. Command: `{meta['command']}`. "
        f"Expected values come from `app/scoring.py` at run time (oracle). Traces of this run: a temp directory, not the repo.",
        "",
        "## Summary",
        "",
        "| Metric | Value |",
        "|---|---|",
        f"| Cases passed (all checks, all repeats) | {pct(case_pass, n_cases)} |",
        f"| Tool-selection accuracy (runs with tool expectations) | {pct(tool_ok, len(tool_runs))} |",
        f"| Grounding passed first try (all turns) | {pct(statuses.count('pass'), len(turns))} |",
        f"| Grounding passed after one retry | {pct(statuses.count('retried'), len(turns))} |",
        f"| Grounding failed or turn errored | {pct(len(turns) - statuses.count('pass') - statuses.count('retried'), len(turns))} |",
        f"| Judge: names the actual top driver | {pct(judge_ok, len(judged))} |",
        f"| Determinism | {'; '.join(determinism) or 'n/a'} |",
        f"| Latency per turn, mean / p95 | {sum(latencies) / max(1, len(latencies)):.1f} s / {_p95(latencies):.1f} s ({len(latencies)} turns) |",
        f"| Tokens, agent (input / output) | {tokens_in:,} / {tokens_out:,} |",
        f"| Tokens, judge (input / output) | {judge_in:,} / {judge_out:,} |",
        f"| Cost estimate for this run | ${agent_cost + judge_cost:.2f} (agent ${agent_cost:.2f}, judge ${judge_cost:.2f}; "
        f"list prices in `app/agent.py`, cached input not discounted) |",
        "",
        "## Per case",
        "",
        "Latency is per run, all turns summed; repeated cases show one value per run.",
        "",
        "| Case | Result | Tools called (last turn) | Grounding | Judge | Latency (s) | Failed checks |",
        "|---|---|---|---|---|---|---|",
        *rows,
        "",
    ]
    return "\n".join(lines)


def preserved_analysis(path: Path) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    i = text.find(ANALYSIS_HEADING)
    return text[i:] if i >= 0 else ""


def dump_details(runs: list[Run], path: Path) -> None:
    out = []
    for r in runs:
        out.append({
            "case": r.case_id, "repeat": r.repeat, "passed": r.passed, "checks": r.checks,
            "tools_called": r.tools_called, "tool_rounds": r.tool_rounds, "judge": r.judge,
            "turns": [{"message": t.message, "latency_s": t.latency_s, "error": t.error,
                       "response": t.response.model_dump(mode="json") if t.response else None} for t in r.turns],
        })
    path.write_text(json.dumps(out, indent=2), encoding="utf-8")


async def main() -> None:
    parser = argparse.ArgumentParser(description="Run the agent eval set against the real model.")
    parser.add_argument("--only", help="comma-separated case ids")
    parser.add_argument("--concurrency", type=int, default=3)
    parser.add_argument("--no-judge", action="store_true")
    parser.add_argument("--out", type=Path, help=f"report path (default {LATEST.relative_to(REPO)})")
    args = parser.parse_args()

    load_dotenv(REPO / ".env")
    from app.agent import DEFAULT_REASONING_EFFORT, get_model
    from app.store import Store, Tracer

    cases = yaml.safe_load(CASES_PATH.read_text(encoding="utf-8"))["cases"]
    if args.only:
        wanted = set(args.only.split(","))
        unknown = wanted - {c["id"] for c in cases}
        if unknown:
            raise SystemExit(f"unknown case ids: {', '.join(sorted(unknown))}")
        cases = [c for c in cases if c["id"] in wanted]

    tmp = Path(tempfile.mkdtemp(prefix="weather-evals-"))
    out = args.out or (tmp / "latest.md" if args.only else LATEST)
    oracle = Oracle()
    from evals.probes import report as probe_report, run_probes_async

    probe_rows = await run_probes_async()  # offline, before any model call
    probe_section = probe_report(probe_rows)
    if not all(r["ok"] for r in probe_rows if not r["known_limit"]):
        print(probe_section)
        raise SystemExit("Offline grounding probes failed: grounding accepted a mis-cited figure. Fix grounding first.")
    model = get_model()
    store, tracer = Store(tmp / "app.db"), Tracer(tmp / "traces.jsonl")
    sem = asyncio.Semaphore(max(1, args.concurrency))
    started = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")
    print(f"Running {len(cases)} cases against {model.id} (concurrency {args.concurrency}); traces in {tmp}", flush=True)

    jobs = [run_case(c, i, model, store, tracer, sem) for c in cases for i in range(c.get("repeat", 1))]
    runs = await asyncio.gather(*jobs)
    traces = load_traces(tmp / "traces.jsonl")
    by_id = {c["id"]: c for c in cases}
    for r in runs:
        attach_trace_data(r, traces)
        check_run(r, by_id[r.case_id], oracle)
    if not args.no_judge:
        await asyncio.gather(*(judge_run(r, by_id[r.case_id], oracle, model, sem) for r in runs))

    meta = {
        "started": started, "model": model.id, "data_as_of": oracle.snapshot.data_as_of,
        "effort": os.environ.get("OPENAI_REASONING_EFFORT", "").strip() or DEFAULT_REASONING_EFFORT,
        "command": "uv run python -m evals.run" + (f" --only {args.only}" if args.only else ""),
    }
    report = build_report(cases, runs, meta)
    breakdown = await grounding_breakdown(runs, traces)
    report = report.replace("## Per case\n", probe_section + "\n" + breakdown + "\n## Per case\n", 1)
    print("\n" + report)
    analysis = preserved_analysis(out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(report + ("\n" + analysis if analysis else ""), encoding="utf-8")
    dump_details(runs, tmp / "details.json")
    print(f"Wrote {out}; per-run details and traces in {tmp}")


if __name__ == "__main__":
    asyncio.run(main())
