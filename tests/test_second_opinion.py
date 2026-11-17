"""JEV second opinion: band mapping, agreement math, what JEV sees, and the cross-check script (no network)."""

from __future__ import annotations

import asyncio
import json

import pytest
from ai.ops.experimental import ScoreAnswer

from app import scoring, second_opinion
from app.schemas import SecondOpinion

FAMILIES = ["winter", "flood", "hurricane", "severe_storm"]
# Keys that would leak our formula's output (or its modelling choices) to JEV.
FORBIDDEN_KEYS = {"score", "exposure", "priority", "band", "normalized", "weight", "contribution", "cap",
                  "days_per_year", "family_weights", "top_driver", "index", "exposure_band", "priority_band"}


def _keys(obj) -> set[str]:
    if isinstance(obj, dict):
        return set(obj) | {k for v in obj.values() for k in _keys(v)}
    if isinstance(obj, list):
        return {k for v in obj for k in _keys(v)}
    return set()


def _strings(obj) -> list[str]:
    if isinstance(obj, dict):
        return [s for v in obj.values() for s in _strings(v)] + list(obj)
    if isinstance(obj, list):
        return [s for v in obj for s in _strings(v)]
    return [obj] if isinstance(obj, str) else []


@pytest.mark.parametrize("score, band", [(0.0, "low"), (0.349, "low"), (0.35, "medium"), (0.599, "medium"),
                                         (0.6, "high"), (1.0, "high")])
def test_band_from_score_uses_index_cut_offs(score, band):
    assert second_opinion.band_from_score(score) == band


def test_score_is_expected_level_normalized_to_fraction():
    # JEV's score is the expected rubric level (0 = low ... 2 = high for three criteria), not a fraction.
    assert second_opinion.normalize_score(1.9, levels=3) == 0.95
    assert second_opinion.normalize_score(0.0, levels=3) == 0.0
    assert second_opinion.normalize_score(1.0, levels=3) == 0.5
    assert second_opinion.normalize_score(2.4, levels=3) == 1.0  # clipped


def _fake_evaluate(scores_by_family: dict[str, float], seen: list, model_id: str = "jev-test-1"):
    """scores_by_family are on JEV's level scale: 0 (low) to 2 (high)."""
    async def evaluate(model, state, questions):
        seen.append((state, questions))
        assert set(questions) == set(FAMILIES)
        return type("Item", (), {"value": {f: ScoreAnswer(type="score", score=scores_by_family[f]) for f in questions},
                                 "usage": None, "provider_metadata": {"typesafe": {"model": model_id}}})()
    return evaluate


def _our_bands() -> dict[str, dict[str, str]]:
    hubs, snapshot = scoring.load_hubs(), scoring.load_snapshot()
    scores = scoring.score_all(hubs, snapshot)
    return {h: {f: scoring.band(s.families[f].score) for f in FAMILIES} for h, s in scores.items()}


def test_agreement_math_with_fake_jev():
    # JEV says "high" (level 1.8 of 2 = 90%) for every family: it agrees exactly where our family band is high.
    seen: list = []
    result = asyncio.run(second_opinion.build_second_opinion(
        evaluate_fn=_fake_evaluate({f: 1.8 for f in FAMILIES}, seen), model=object()))
    ours = _our_bands()
    expected_agree = sum(1 for bands in ours.values() for b in bands.values() if b == "high")

    assert isinstance(result, SecondOpinion)
    assert len(seen) == 15  # one batched call per hub
    assert result.total == 60 and len(result.hubs) == 15
    assert result.agree_count == expected_agree
    assert result.agreement_pct == round(100 * expected_agree / 60, 1)
    for hub in result.hubs:
        assert hub.total == 4 and hub.agree_count == sum(f.agrees for f in hub.families)
        for f in hub.families:
            assert f.our_band == ours[hub.hub_id][f.family]
            assert f.jev_band == "high" and f.jev_score_pct == 90.0
            assert f.agrees == (f.our_band == "high")
    assert result.data_as_of == scoring.load_snapshot().data_as_of
    assert result.model == "jev-test-1"  # the version the provider reports, not the alias
    assert "does not affect scores or rankings" in result.note


def test_state_sent_to_jev_has_only_raw_signals():
    seen: list = []
    asyncio.run(second_opinion.build_second_opinion(
        evaluate_fn=_fake_evaluate({f: 0.1 for f in FAMILIES}, seen), model=object()))
    hubs = scoring.load_hubs()
    names = {h.id for h in hubs} | {h.name.lower() for h in hubs}
    for state, questions in seen:
        assert not _keys(state) & FORBIDDEN_KEYS
        text = " ".join(_strings(state)).lower()
        assert "days/event" not in text and "area-adjusted" not in text  # our modelling choices stay out
        assert not any(n in text for n in names)  # anonymous: JEV rates the signals, not the city
        assert set(state["signals_by_family"]) == set(FAMILIES)
        for rows in state["signals_by_family"].values():
            assert rows and all(set(r) == {"signal", "value", "unit", "source"} for r in rows)
        for q in questions.values():
            assert len(q.criteria) == 3


def test_missing_nri_value_is_sent_as_null_not_zero():
    seen: list = []
    asyncio.run(second_opinion.build_second_opinion(
        evaluate_fn=_fake_evaluate({f: 0.1 for f in FAMILIES}, seen), model=object()))
    values = [r["value"] for state, _ in seen for rows in state["signals_by_family"].values() for r in rows]
    assert None in values  # e.g. ice storm in Miami is missing in NRI


def test_crosscheck_skips_without_key(monkeypatch, tmp_path, capsys):
    from evals import jev_crosscheck

    monkeypatch.delenv("TYPESAFE_API_KEY", raising=False)
    monkeypatch.setattr(jev_crosscheck, "load_dotenv", lambda *a, **k: None)
    code = jev_crosscheck.main(json_path=tmp_path / "o.json", md_path=tmp_path / "o.md")
    assert code == 0
    assert "skip" in capsys.readouterr().out.lower()
    assert not (tmp_path / "o.json").exists()


def test_crosscheck_writes_json_and_report(monkeypatch, tmp_path):
    from evals import jev_crosscheck

    monkeypatch.setenv("TYPESAFE_API_KEY", "test-key")
    monkeypatch.setattr(jev_crosscheck, "load_dotenv", lambda *a, **k: None)

    async def builder(**kwargs):
        return await second_opinion.build_second_opinion(
            evaluate_fn=_fake_evaluate({"winter": 0.4, "flood": 1.0, "hurricane": 0.2, "severe_storm": 0.8}, []),
            model=object(), **kwargs)

    code = jev_crosscheck.main(json_path=tmp_path / "o.json", md_path=tmp_path / "o.md", builder=builder)
    assert code == 0
    saved = SecondOpinion.model_validate(json.loads((tmp_path / "o.json").read_text()))
    report = (tmp_path / "o.md").read_text()
    assert saved.total == 60
    assert "Agreement by family" in report and "Disagreements" in report
    assert f"{saved.agreement_pct}%" in report


def test_spearman_handles_order_ties_and_constant_input():
    from evals.jev_crosscheck import spearman

    assert spearman([1, 2, 3], [10, 20, 30]) == 1.0
    assert spearman([1, 2, 3], [30, 20, 10]) == -1.0
    assert spearman([1, 1, 2], [5, 5, 9]) == 1.0
    assert spearman([1, 2, 3], [7, 7, 7]) is None
