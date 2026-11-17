"""JEV cross-check: `uv run python -m evals.jev_crosscheck` (or `make jev`).

Runs `app.second_opinion.build_second_opinion()` (15 TypeSafe JEV calls), then writes
`data/jev_second_opinion.json` (served by GET /second-opinion; written atomically) and
`evals/results/jev_crosscheck.md` (agreement per family and per hub, the disagreement list).
A hand-written "## Interpretation" section in the report is kept across reruns.
Without TYPESAFE_API_KEY it prints a skip message and exits 0. Never imported by `app/`.
"""

from __future__ import annotations

import asyncio
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

from app.schemas import SecondOpinion

REPO = Path(__file__).resolve().parents[1]
JSON_PATH = REPO / "data" / "jev_second_opinion.json"
MD_PATH = REPO / "evals" / "results" / "jev_crosscheck.md"
INTERPRETATION_HEADING = "## Interpretation"
FAMILIES = ["winter", "flood", "hurricane", "severe_storm"]
_ORDER = {"low": 0, "medium": 1, "high": 2}


def _write_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def build_report(op: SecondOpinion, stats: list[dict], elapsed_s: float | None) -> str:
    rows = [(h, f) for h in op.hubs for f in h.families]
    lines = [
        "# JEV cross-check",
        "",
        f"{op.note}",
        "",
        f"Model `{op.model}`, run {op.run_at}, snapshot data as of {op.data_as_of}. Command: `make jev`. "
        "JEV sees only each hub's raw signals (FEMA NRI annualized event frequencies, observed day counts, county "
        "area), not the hub's name and none of our scores, bands, weights or days-per-event assumptions. JEV's "
        "score is the expected rubric level (0 = low, 1 = medium, 2 = high); it is scaled to 0-100% and mapped to "
        "bands with our cut-offs (35% / 60%).",
        "",
        f"**Overall agreement: {op.agreement_pct}%** ({op.agree_count} of {op.total} hub-family ratings).",
    ]
    if stats:
        lat = [s["latency_s"] for s in stats]
        lines.append(f"JEV calls: {len(stats)}, latency per call mean {sum(lat) / len(lat):.1f} s, max {max(lat):.1f} s"
                     + (f", whole run {elapsed_s:.1f} s." if elapsed_s is not None else "."))
        usage = [s["usage"] for s in stats if s.get("usage")]
        if usage:
            tin = sum(u.get("input_tokens") or 0 for u in usage)
            tout = sum(u.get("output_tokens") or 0 for u in usage)
            lines.append(f"Tokens reported by the provider: {tin:,} input / {tout:,} output (cost is not reported).")
    lines += ["", "## Agreement by family", "",
              "Our band is the formula's per-family band (by days per year; hurricane by 10-year probability). "
              "Rank correlation compares the order of hubs (Spearman, JEV score vs our family days per year), which band "
              "agreement cannot: two raters can order hubs the same way and still put the cut-offs in different places.",
              "",
              "| Family | Agree | JEV rates higher | JEV rates lower | Rank correlation |", "|---|---|---|---|---|"]
    rc = op.rank_correlation or {}
    for fam in FAMILIES:
        fr = [f for _, f in rows if f.family == fam]
        agree = sum(f.agrees for f in fr)
        higher = sum(_ORDER[f.jev_band] > _ORDER[f.our_band] for f in fr)
        lower = sum(_ORDER[f.jev_band] < _ORDER[f.our_band] for f in fr)
        rho = rc.get(fam)
        lines.append(f"| {fam} | {agree}/{len(fr)} ({100 * agree / len(fr):.0f}%) | {higher} | {lower} | "
                     f"{'n/a' if rho is None else f'{rho:+.2f}'} |")

    lines += ["", "## Agreement by hub", "",
              "Each cell: our band / JEV band (JEV score in %).", "",
              "| Hub | Agree | " + " | ".join(FAMILIES) + " |", "|---|---|" + "---|" * len(FAMILIES)]
    for h in sorted(op.hubs, key=lambda h: (h.agree_count, h.hub_id)):
        by = {f.family: f for f in h.families}
        cells = [f"{by[f].our_band} / {by[f].jev_band} ({by[f].jev_score_pct:g})" + ("" if by[f].agrees else " ✗")
                 for f in FAMILIES]
        lines.append(f"| {h.name} | {h.agree_count}/{h.total} | " + " | ".join(cells) + " |")

    dis = [(h, f) for h, f in rows if not f.agrees]
    lines += ["", f"## Disagreements ({len(dis)})", ""]
    if dis:
        lines += ["| Hub | Family | Our band | JEV band | JEV score (%) |", "|---|---|---|---|---|"]
        for h, f in sorted(dis, key=lambda x: (x[1].family, x[0].hub_id)):
            lines.append(f"| {h.name} | {f.family} | {f.our_band} | {f.jev_band} | {f.jev_score_pct:g} |")
    else:
        lines.append("None.")
    lines.append("")
    return "\n".join(lines)


def _preserved(path: Path) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8")
    i = text.find(INTERPRETATION_HEADING)
    return text[i:] if i >= 0 else ""


def main(json_path: Path = JSON_PATH, md_path: Path = MD_PATH, builder=None) -> int:
    load_dotenv(REPO / ".env")
    if not os.environ.get("TYPESAFE_API_KEY"):
        print("Skipping the JEV cross-check: TYPESAFE_API_KEY is not set (see .env.example).")
        return 0
    if builder is None:
        from app.second_opinion import build_second_opinion as builder

    stats: list[dict] = []
    start = time.perf_counter()
    opinion = asyncio.run(builder(stats=stats))
    elapsed = round(time.perf_counter() - start, 1)
    _write_atomic(json_path, opinion.model_dump_json(indent=2) + "\n")
    report = build_report(opinion, stats, elapsed)
    kept = _preserved(md_path)
    _write_atomic(md_path, report + ("\n" + kept if kept else ""))
    print(report)
    print(f"Wrote {json_path} and {md_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
