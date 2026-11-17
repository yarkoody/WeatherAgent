"""A2: deterministic scoring over the hand-built snapshot in tests/fixtures/snapshots.py.

Expected values are worked by hand from Eden's config (spec section 6, formula v2). The fixture repeats the
same events every year, so 2015-2025 observed rates equal the per-year counts (to 0.01; 4018 days / 365.25).
alpha  winter 0.6*(10*0.5 + 1*2 + 2*1) + 0.4*8 = 8.6 days; flood 0.6*(2*2) + 0.4*3 = 3.6;
       severe 0.6*(0.4*0.5 + 4*0.25 + 4*0.25) + 0.4*2 = 2.12; total 14.32 days -> index 57.28.
       priority 57.28 * (0.6 + 0.25*0.5 + 0.15*0.4) = 44.96.
bravo  (county 4,000 sq mi -> local hazards x0.25; coastal flood x 400/4000 exposed area)
       flood 0.6*(8*2*0.25 + 2*2*0.1) + 0.4*5 = 4.64; hurricane 0.3*10 = 3.0;
       severe 0.6*(2*0.5 + 2*0.25 + 2*0.25)*0.25 + 0.4*1 = 0.7; total 8.34 -> index 33.36.
       priority 33.36 * (0.6 + 0.25*1 + 0.15*0.8) = 32.36. Hurricane 10-yr probability 1 - e^-3 = 95.0%.
charlie winter 0.6*40 + 0.4*30 = 36 days -> index clipped at 100; priority 100 * (0.6 + 0.05 + 0.015) = 66.5.
Bad year (TVaR95) is checked against an independent Poisson convolution in the tests below.
"""

import math

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
    assert scores["bravo"].exposure == 33.4


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
    assert "area-adjusted" not in coastal.note  # coastal is not a local hazard
    assert _signal(scores["alpha"], "flood", "inland flood").note is None  # 500 sq mi: no change


def test_coastal_flood_scaled_by_exposed_area_share(scores):
    coastal = _signal(scores["bravo"], "flood", "coastal flood")
    assert coastal.normalized == pytest.approx(0.4)  # 2 events * 2 days * (400 / 4000 sq mi exposed)
    assert "10.0% of county area exposed" in coastal.note


def test_null_nri_counts_as_zero_with_note(scores):
    sig = _signal(scores["alpha"], "flood", "coastal flood")
    assert sig.raw is None
    assert sig.normalized == 0.0
    assert sig.note == "missing in NRI"


def test_observed_window_defaults_to_full_snapshot():
    assert (DEFAULT_CONFIG.observed_start, DEFAULT_CONFIG.observed_end) == ("2015-01-01", "2025-12-31")


def test_observed_signal_counts_disruption_days(scores):
    obs = _signal(scores["alpha"], "winter", "observed")
    assert obs.raw == pytest.approx(8.0, abs=0.01)  # union of 5 snow days and 8 cold days, per year
    assert obs.unit == "days/year"
    assert obs.weight == 0.4


def test_priority_formula(scores):
    # multiplicative: exposure index x (0.6 + 0.25 x people share + 0.15 x resilience-gap share)
    assert scores["alpha"].priority == 45.0  # 57.28 * 0.785
    assert scores["bravo"].priority == 32.4  # 33.36 * 0.97 (6M people clipped at 5M)
    assert scores["bravo"].priority_band == "low"
    assert scores["charlie"].priority == 66.5
    sig = scores["alpha"].priority_signals
    assert [s.weight for s in sig] == [0.6, 0.25, 0.15]
    assert sum(s.contribution for s in sig) == pytest.approx(scores["alpha"].priority, abs=0.05)


def test_priority_is_zero_without_exposure():
    assert scoring._priority(0.0, {"POPULATION": 10_000_000, "RESL_SCORE": 0}, DEFAULT_CONFIG)[0] == 0.0


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
    t = scores["alpha"].band_thresholds
    assert (t.family_medium_from_days, t.family_high_from_days) == (2.0, 5.0)
    assert (t.hurricane_medium_from_pct, t.hurricane_high_from_pct) == (20.0, 50.0)
    assert scores["alpha"].data_as_of == "2026-11-17"


def test_family_bands_use_days_and_hurricane_probability(scores):
    a = scores["alpha"].families
    assert (a["winter"].band, a["flood"].band, a["severe_storm"].band, a["hurricane"].band) == (
        "high", "medium", "medium", "low")  # 8.6, 3.6, 2.12 days; no hurricanes
    assert scores["bravo"].families["hurricane"].band == "high"  # 95% chance in 10 years
    assert [scoring.family_band(d) for d in (1.99, 2.0, 4.99, 5.0)] == ["low", "medium", "medium", "high"]
    assert [scoring.hurricane_band(p) for p in (19.9, 20.0, 49.9, 50.0)] == ["low", "medium", "medium", "high"]


def test_hurricane_10yr_probability(scores):
    assert scores["bravo"].hurricane_10yr_probability_pct == 95.0  # (1 - e^(-10 x 0.3)) x 100
    assert scores["alpha"].hurricane_10yr_probability_pct == 0.0  # null in NRI


def _poisson(lam, n):
    return [math.exp(-lam) * lam**k / math.factorial(k) for k in range(n)]


def _tvar_from_pmf(pmf, step, alpha=0.95):
    """Reference TVaR: mean of the worst (1 - alpha) of years, splitting the atom at the quantile."""
    cum = 0.0
    for v, p in enumerate(pmf):
        cum += p
        if cum >= alpha:
            break
    tail = sum(x * step * p for x, p in enumerate(pmf) if x > v) + v * step * (cum - alpha)
    return tail / (1 - alpha)


def test_tvar_of_a_poisson_count_matches_the_closed_form():
    # one stream of 1-day events at 3 per year: annual days ~ Poisson(3)
    tvar, shares = scoring.tvar95({"winter": [(1.0, 3.0)]})
    assert tvar == pytest.approx(_tvar_from_pmf(_poisson(3.0, 80), 1.0), abs=1e-9)
    assert shares == {"winter": pytest.approx(tvar, abs=1e-9)}


def test_tvar_of_two_streams_matches_a_direct_convolution():
    # 1-day events at rate 2 (winter) + 2-day events at rate 0.5 (flood), computed by brute force
    a, b = _poisson(2.0, 60), _poisson(0.5, 30)
    pmf = [0.0] * 120
    for i, pa in enumerate(a):
        for j, pb in enumerate(b):
            pmf[i + 2 * j] += pa * pb
    tvar, shares = scoring.tvar95({"winter": [(1.0, 2.0)], "flood": [(2.0, 0.5)]})
    assert tvar == pytest.approx(_tvar_from_pmf(pmf, 1.0), abs=1e-9)
    assert sum(shares.values()) == pytest.approx(tvar, abs=1e-9)  # Euler allocation is exact
    assert shares["winter"] > 2.0 and shares["flood"] > 1.0  # each above its own mean


def test_tvar_handles_quarter_and_eighth_day_events():
    t1, _ = scoring.tvar95({"severe_storm": [(0.25, 4.0)]})  # 4 events x 0.25 days = Poisson(4) / 4
    assert t1 == pytest.approx(_tvar_from_pmf(_poisson(4.0, 80), 0.25), abs=1e-9)
    t2, _ = scoring.tvar95({"severe_storm": [(0.125, 4.0)]})  # off the quarter grid: the step adapts
    assert t2 == pytest.approx(_tvar_from_pmf(_poisson(4.0, 80), 0.125), abs=1e-9)


def test_tvar_of_nothing_is_zero():
    assert scoring.tvar95({"winter": [], "flood": [(2.0, 0.0)]}) == (0.0, {"winter": 0.0, "flood": 0.0})


def test_bad_year_is_tvar95_with_family_allocation(scores):
    for hub in ("alpha", "bravo", "charlie"):
        h = scores[hub]
        assert h.bad_year_days > h.exposure_days_per_year
        assert sum(f.bad_year_days for f in h.families.values()) == pytest.approx(h.bad_year_days, abs=0.25)
    b = scores["bravo"].families
    excess = {f: b[f].bad_year_days - b[f].days_per_year for f in b}
    assert max(excess, key=excess.get) == "hurricane"  # the 35-day hurricane tail drives bravo's bad year
    assert scores["bravo"].bad_year_days > scores["alpha"].bad_year_days  # although alpha's typical year is worse
    assert DEFAULT_CONFIG.hurricane_days_mix == ((0.8, 4.0), (0.2, 35.0))
    assert DEFAULT_CONFIG.bad_year_alpha == 0.95


def test_rank_by_bad_year(scores):
    r = scoring.rank(scores, HUBS, "bad_year")
    assert [i.hub_id for i in r.items] == ["charlie", "bravo", "alpha", "delta"]
    assert [i.value for i in r.items] == [scores[i.hub_id].bad_year_days for i in r.items]
    assert all(i.band is None for i in r.items)  # no meaningful band for the tail lens
    with pytest.raises(ValueError):
        scoring.rank(scores, HUBS, "bad_year", hazard="winter")


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
    assert [i.hub_id for i in p.items] == ["charlie", "alpha", "delta", "bravo"]
    assert p.data_as_of == "2026-11-17"


def test_rank_by_hazard_uses_family_score(scores):
    r = scoring.rank(scores, HUBS, "exposure", hazard="hurricane", top_n=1)
    assert [(i.hub_id, i.value, i.band) for i in r.items] == [("bravo", 12.0, "high")]  # family band


def test_rank_region_filter(scores):
    r = scoring.rank(scores, HUBS, "priority", region="Midwest")
    assert [i.hub_id for i in r.items] == ["alpha"]
    assert r.region == "Midwest"


def test_rank_hazard_with_priority_raises(scores):
    with pytest.raises(ValueError):
        scoring.rank(scores, HUBS, "priority", hazard="winter")


def test_score_rows_sorted_by_priority(scores):
    rows = scoring.score_rows(scores, HUBS)
    assert [r.hub_id for r in rows] == ["charlie", "alpha", "delta", "bravo"]
    assert rows[1].name == "Alpha Hub" and rows[1].region == "Midwest"
    assert (rows[1].exposure_days_per_year, rows[1].bad_year_days, rows[1].hurricane_10yr_probability_pct) == (
        14.3, scores["alpha"].bad_year_days, 0.0)


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
        ("charlie", 66.5), ("alpha", 36.0), ("delta", 36.0), ("bravo", 35.2)]
    assert [(p.hub_id, p.priority_per_million) for p in r.per_million_ranking] == [("alpha", 18.0), ("bravo", 3.52)]
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
    assert all("CFLD_EXP_AREA" in c for c in snap.nri["counties"].values())
    s = scoring.score_all(hubs, snap)
    assert REGRESSION == {h: (s[h].exposure_days_per_year, s[h].bad_year_days, s[h].priority) for h in REGRESSION}
    bands = [x.exposure_band for x in s.values()]
    assert (bands.count("low"), bands.count("medium"), bands.count("high")) == (3, 6, 6)
    assert s["miami"].hurricane_10yr_probability_pct == 95.3
    # bands follow the displayed (rounded) value: LA winter is 1.97 days, shown as 2.0, so medium
    assert (s["los_angeles"].families["winter"].days_per_year, s["los_angeles"].families["winter"].band) == (2.0, "medium")


# (expected days, bad-year TVaR95 days, priority) from the reviewed run; spec section 6 quotes these
REGRESSION = {
    "minneapolis": (27.6, 38.7, 66.7),
    "chicago": (18.1, 29.1, 64.5),
    "newark": (15.0, 35.4, 45.2),
    "houston": (10.5, 38.2, 40.3),
    "miami": (7.8, 42.8, 25.6),
    "los_angeles": (3.7, 8.4, 14.4),
    "phoenix": (1.6, 7.2, 5.9),
}


def test_coastal_flood_without_exposed_area_uses_the_default_share():
    import copy

    nri = copy.deepcopy(SNAPSHOT.nri)
    nri["counties"]["00002"]["CFLD_EXP_AREA"] = None
    snap = scoring.Snapshot(nri=nri, weather=SNAPSHOT.weather)
    coastal = _signal(scoring.score_all(HUBS, snap)["bravo"], "flood", "coastal flood")
    assert coastal.normalized == pytest.approx(2 * 2 * 0.0405)
    assert "default share 4.05%" in coastal.note
