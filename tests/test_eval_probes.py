"""The offline grounding probes in evals/probes.py run in CI too (real tool output, no model)."""

from evals.probes import run_probes


def test_grounding_rejects_mis_cited_figures_and_accepts_correct_ones():
    rows = run_probes()
    bad = [r["id"] for r in rows if not r["ok"] and not r["known_limit"]]
    assert not bad, bad
    assert any(r["id"] == "adversarial_priority_as_hurricane_probability" and not r["grounding_passed"] for r in rows)
