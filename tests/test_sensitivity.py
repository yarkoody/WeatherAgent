"""Sensitivity analysis of the expected-days ranking (formula v2)."""

from app import sensitivity
from tests.fixtures.snapshots import HUBS, SNAPSHOT


def test_spearman_identity_and_reverse():
    a = ["x", "y", "z", "w"]
    assert sensitivity.spearman(a, a) == 1.0
    assert sensitivity.spearman(a, list(reversed(a))) == -1.0


def test_run_covers_every_days_per_event_value_and_blend():
    result = sensitivity.run(HUBS, SNAPSHOT)
    dpe = [r for r in result.rows if r.group == "days per event"]
    blend = [r for r in result.rows if r.group == "NRI / observed blend"]
    assert len(dpe) == 9 * 2  # each value halved and doubled
    assert [r.label for r in blend] == [f"NRI {w:.1f} / observed {1 - w:.1f}" for w in (0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0)]
    current = next(r for r in blend if r.label == "NRI 0.6 / observed 0.4")
    assert current.spearman == 1.0 and current.top_hub == result.base_order[0] and not current.top_changed


def test_unchanged_order_reports_no_move():
    result = sensitivity.run(HUBS, SNAPSHOT)
    row = next(r for r in result.rows if r.label == "HRCN x2")  # bravo 8.3 -> 11.3 days, still below alpha's 14.3
    assert row.spearman == 1.0 and row.biggest_move == "none" and not row.top_changed


def test_top_hub_is_reported():
    result = sensitivity.run(HUBS, SNAPSHOT)
    row = next(r for r in result.rows if r.label == "WNTW x0.5")
    assert row.top_hub == "charlie"  # 0.6*(40*0.25 + 5*2 + 10*1) + 0.4*30 = 30 days, still first


def test_markdown_report_lists_results():
    md = sensitivity.to_markdown(sensitivity.run(HUBS, SNAPSHOT))
    assert "Spearman" in md and "HRCN x0.5" in md and "NRI 1.0 / observed 0.0" in md
