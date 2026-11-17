"""A2: deterministic scoring over the hand-built snapshot in tests/fixtures/snapshots.py.

Expected values are worked by hand from Eden's config (spec section 6):
alpha  winter 0.6*(10*0.5 + 1*2 + 2*1) + 0.4*8 = 8.6 days; flood 0.6*(2*2) + 0.4*3 = 3.6;
       severe 0.6*(0.4*0.5 + 4*0.25 + 4*0.25) + 0.4*2 = 2.12; total 14.32 days -> index 57.28.
bravo  (county 4,000 sq mi -> local hazards x0.25) flood 0.6*(8*2*0.25 + 2*2) + 0.4*5 = 6.8;
       hurricane 0.3*10 = 3.0; severe 0.6*(2*0.5 + 2*0.25 + 2*0.25)*0.25 + 0.4*1 = 0.7; total 10.5 -> 42.0.
charlie winter 0.6*40 + 0.4*30 = 36 days -> index clipped at 100.
"""

import pytest

from app import scoring
from app.schemas import WhatIfInput
from app.scoring import DEFAULT_CONFIG, DataUnavailable, ScoringConfig
from tests.fixtures.snapshots import HUBS, SNAPSHOT


@pytest.fixture(scope="module")
def scores():
    return scoring.score_all(HUBS, SNAPSHOT)


def _signal(hub_score, family, name_part):
    return next(s for s in hub_score.families[family].signals if name_part in s.name)


def test_config_holds_eden_values():
    c = DEFAULT_CONFIG
    assert c.days_per_event == {"HRCN": 10, "ISTM": 2, "IFLD": 2, "CFLD": 2, "WNTW": 0.5,
                                "CWAV": 1, "TRND": 0.5, "SWND": 0.25, "HAIL": 0.25}
    assert (c.nri_weight, c.observed_weight) == (0.6, 0.4)
    assert c.exposure_days_cap == 25
    assert (c.priority_exposure_weight, c.priority_people_weight, c.priority_resilience_weight) == (0.6, 0.25, 0.15)


def test_normalize_clips_at_cap(scores):
    assert scoring.normalize(36, 25) == 100.0
    assert scoring.normalize(12.5, 25) == 50.0
    assert scores["charlie"].exposure == 100.0
    assert scores["charlie"].families["winter"].score == 100.0


def test_hurricane_family_uses_nri_only(scores):
    hurricane = scores["bravo"].families["hurricane"]
    assert len(hurricane.signals) == 1
    sig = hurricane.signals[0]
    assert sig.weight == 1.0
    assert sig.raw == 0.3
    assert sig.contribution == pytest.approx(3.0)
    assert hurricane.score == 12.0  # 3 days / 25 * 100


def test_exposure_is_sum_of_family_days(scores):
    a = scores["alpha"]
    assert a.exposure == 57.3
    assert a.families["winter"].score == 34.4
    assert a.families["flood"].score == 14.4
    assert a.families["severe_storm"].score == 8.5
    assert a.families["hurricane"].score == 0.0
    assert a.family_weights["winter"] == 60.1  # percent of days: 8.6 / 14.32
    assert sum(a.family_weights.values()) == pytest.approx(100.0, abs=0.2)
    assert scores["bravo"].exposure == 42.0


def test_days_fields_report_expected_disruption_days(scores):
    a = scores["alpha"]
    assert a.exposure_days_per_year == 14.3  # 8.6 + 3.6 + 0 + 2.12 = 14.32
    assert a.families["winter"].days_per_year == 8.6
    assert a.families["severe_storm"].days_per_year == 2.1
    assert scores["bravo"].families["hurricane"].days_per_year == 3.0
    assert scores["charlie"].exposure_days_per_year == 36.0  # not clipped: only the index is capped


def test_area_adjustment_scales_local_hazards_in_large_counties(scores):
    inland = _signal(scores["bravo"], "flood", "inland flood")
    assert inland.normalized == pytest.approx(4.0)  # 8 events * 2 days * 1000/4000
    assert "area" in inland.note
    coastal = _signal(scores["bravo"], "flood", "coastal flood")
    assert coastal.normalized == pytest.approx(4.0)  # coastal is not a local hazard: no adjustment
    assert _signal(scores["alpha"], "flood", "inland flood").note is None  # 500 sq mi: no change


def test_null_nri_counts_as_zero_with_note(scores):
    sig = _signal(scores["alpha"], "flood", "coastal flood")
    assert sig.raw is None
    assert sig.normalized == 0.0
    assert sig.note == "missing in NRI"


def test_observed_signal_counts_disruption_days(scores):
    obs = _signal(scores["alpha"], "winter", "observed")
    assert obs.raw == pytest.approx(8.0, abs=0.01)  # union of 5 snow days and 8 cold days, per year
    assert obs.unit == "days/year"
    assert obs.weight == 0.4


def test_priority_formula(scores):
    # alpha: 0.6*57.28 + 0.25*(2.5M/5M*100) + 0.15*(100-60)
    assert scores["alpha"].priority == 52.9
    # bravo: 0.6*42 + 0.25*100 (6M clipped) + 0.15*80
    assert scores["bravo"].priority == 62.2
    assert scores["bravo"].priority_band == "high"
    weights = [s.weight for s in scores["alpha"].priority_signals]
    assert weights == [0.6, 0.25, 0.15]


def test_bands_thresholds(scores):
    assert scoring.band(34.9) == "low"
    assert scoring.band(35.0) == "medium"
    assert scoring.band(59.9) == "medium"
    assert scoring.band(60.0) == "high"
    assert scores["alpha"].band_thresholds.medium_from == 35.0
    assert scores["alpha"].band_thresholds.high_from == 60.0
    assert scores["alpha"].band_thresholds.days_cap == 25.0
    assert scores["alpha"].band_thresholds.medium_from_days == 8.75
    assert scores["alpha"].band_thresholds.high_from_days == 15.0
    assert scoring.rank(scores, HUBS, "exposure").band_thresholds.medium_from_days == 8.75
    assert scores["alpha"].data_as_of == "2026-11-17"


def test_top_driver_is_largest_contribution(scores):
    assert scores["alpha"].top_driver == "winter"
    assert scores["bravo"].top_driver == "flood"


def test_upgrade_categories_follow_top_driver(scores):
    assert scores["alpha"].upgrade_categories == scoring.UPGRADE_CATEGORIES["winter"]
    assert scores["bravo"].upgrade_categories == scoring.UPGRADE_CATEGORIES["flood"]
    assert set(scoring.UPGRADE_CATEGORIES) == {"winter", "flood", "hurricane", "severe_storm"}


def test_score_all_is_deterministic():
    one = {k: v.model_dump_json() for k, v in scoring.score_all(HUBS, SNAPSHOT).items()}
    two = {k: v.model_dump_json() for k, v in scoring.score_all(list(reversed(HUBS)), SNAPSHOT).items()}
    assert one == two


def test_rank_is_deterministic_and_ties_break_by_id(scores):
    r = scoring.rank(scores, HUBS, "exposure")
    assert [i.hub_id for i in r.items] == ["charlie", "alpha", "delta", "bravo"]
    assert [i.rank for i in r.items] == [1, 2, 3, 4]
    assert r.items[1].value == r.items[2].value == 57.3
    p = scoring.rank(scores, HUBS, "priority")
    assert [i.hub_id for i in p.items] == ["charlie", "bravo", "alpha", "delta"]
    assert p.data_as_of == "2026-11-17"


def test_rank_by_hazard_uses_family_score(scores):
    r = scoring.rank(scores, HUBS, "exposure", hazard="hurricane", top_n=1)
    assert [(i.hub_id, i.value, i.band) for i in r.items] == [("bravo", 12.0, "low")]


def test_rank_region_filter(scores):
    r = scoring.rank(scores, HUBS, "priority", region="Midwest")
    assert [i.hub_id for i in r.items] == ["alpha"]
    assert r.region == "Midwest"


def test_rank_hazard_with_priority_raises(scores):
    with pytest.raises(ValueError):
        scoring.rank(scores, HUBS, "priority", hazard="winter")


def test_score_rows_sorted_by_priority(scores):
    rows = scoring.score_rows(scores, HUBS)
    assert [r.hub_id for r in rows] == ["charlie", "bravo", "alpha", "delta"]
    assert rows[2].name == "Alpha Hub" and rows[2].region == "Midwest"


def test_weather_stat_snow_days_pct():
    s = scoring.weather_stat(SNAPSHOT, "alpha", "snow_days_pct", 2025)
    assert s.numerator == 8  # 5 snow days + 3 trace days of exactly 0.1 cm; 0.09 cm does not count
    assert s.denominator == 365
    assert s.value == 2.2
    assert s.unit == "%"
    assert "0.1 cm" in s.definition
    assert scoring.weather_stat(SNAPSHOT, "alpha", "snow_days_pct", 2024).denominator == 366


def test_weather_stat_other_metrics():
    assert scoring.weather_stat(SNAPSHOT, "bravo", "heavy_rain_days", 2023).value == 5
    assert scoring.weather_stat(SNAPSHOT, "alpha", "freezing_days_pct", 2025).numerator == 8
    assert scoring.weather_stat(SNAPSHOT, "alpha", "high_wind_days", 2025).value == 2
    assert scoring.weather_stat(SNAPSHOT, "charlie", "total_snowfall_cm", 2025).value == 180.1  # 30 x 6 cm + one 0.09 cm day


@pytest.mark.parametrize("year", [2014, 2026])
def test_weather_stat_rejects_year_outside_snapshot(year):
    with pytest.raises(DataUnavailable):
        scoring.weather_stat(SNAPSHOT, "alpha", "snow_days_pct", year)


def test_weather_stat_rejects_unknown_hub():
    with pytest.raises(DataUnavailable):
        scoring.weather_stat(SNAPSHOT, "nowhere", "snow_days_pct", 2025)


def test_what_if_renormalizes_weights_and_ranks_per_million():
    inputs = WhatIfInput.model_validate({
        "family_weights": {"hurricane": 0.5},
        "upgrade_costs": [{"hub_id": "bravo", "cost_musd": 10}, {"hub_id": "alpha", "cost_musd": 2}],
    })
    r = scoring.what_if(HUBS, SNAPSHOT, inputs)
    assert r.kind == "priority"
    assert [(i.hub_id, i.value) for i in r.ranking] == [
        ("charlie", 66.5), ("bravo", 62.9), ("alpha", 46.0), ("delta", 46.0)]
    assert [(p.hub_id, p.priority_per_million) for p in r.per_million_ranking] == [("alpha", 23.0), ("bravo", 6.29)]
    assert r.inputs_echo == inputs
    assert "analyst-supplied" in r.note
    assert "hurricane 0.4" in r.note and "winter 0.2" in r.note  # 0.5 / 1.25 and 0.25 / 1.25


def test_what_if_without_inputs_matches_base_priority(scores):
    r = scoring.what_if(HUBS, SNAPSHOT, WhatIfInput())
    assert [(i.hub_id, i.value) for i in r.ranking] == [
        (i.hub_id, i.value) for i in scoring.rank(scores, HUBS, "priority").items]
    assert r.per_million_ranking is None


def test_what_if_rejects_unknown_hub_cost():
    inputs = WhatIfInput.model_validate({"upgrade_costs": [{"hub_id": "atlantis", "cost_musd": 5}]})
    with pytest.raises(ValueError, match="atlantis"):
        scoring.what_if(HUBS, SNAPSHOT, inputs)


def test_custom_config_changes_scores():
    cfg = ScoringConfig(exposure_days_cap=50)
    assert scoring.score_all(HUBS, SNAPSHOT, cfg)["alpha"].exposure == 28.6  # 14.32 / 50


def test_observed_days_use_actual_window_span():
    # 2023-11-01..2025-10-31 spans three calendar years but only two years of days (731).
    cfg = ScoringConfig(observed_start="2023-11-01", observed_end="2025-10-31")
    obs = _signal(scoring.score_all(HUBS, SNAPSHOT, cfg)["alpha"], "winter", "observed")
    assert obs.raw == pytest.approx(8.0, abs=0.01)  # 16 event days / (731 / 365.25)


def test_observed_signal_note_counts_nulls():
    import copy
    from tests.fixtures.snapshots import FETCHED_AT

    weather = copy.deepcopy(SNAPSHOT.weather)
    series = weather["hubs"]["alpha"]
    i = series["time"].index("2024-03-01")
    series["precipitation_sum"][i] = None
    series["precipitation_sum"][i + 1] = None
    snap = scoring.Snapshot(nri=SNAPSHOT.nri, weather=weather)
    a = scoring.score_all(HUBS, snap)["alpha"]
    assert "2 null values" in _signal(a, "flood", "observed").note
    assert "0 null values" in _signal(a, "winter", "observed").note
    assert snap.data_as_of == FETCHED_AT[:10]


@pytest.mark.parametrize("bad", [float("inf"), float("nan"), 1e7])
def test_what_if_rejects_non_finite_or_huge_weights(bad):
    with pytest.raises(ValueError):  # NaN already fails the schema's gt=0; inf and 1e7 fail in what_if
        scoring.what_if(HUBS, SNAPSHOT, WhatIfInput.model_validate({"family_weights": {"winter": bad}}))


def test_committed_snapshot_matches_spec_values():
    hubs, snap = scoring.load_hubs(), scoring.load_snapshot()
    assert len(hubs) == 15
    assert all(len(snap.weather["hubs"][h.id]["time"]) == 4018 for h in hubs)
    s = scoring.score_all(hubs, snap)
    assert s["minneapolis"].exposure_days_per_year == 26.3
    assert (s["los_angeles"].exposure, s["los_angeles"].priority) == (28.9, 55.3)
    bands = [x.exposure_band for x in s.values()]
    assert (bands.count("low"), bands.count("medium"), bands.count("high")) == (3, 7, 5)
