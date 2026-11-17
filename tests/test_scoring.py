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
    # multiplicative: exposure index x (0.6 + 0.25 x people share + 0.15 x resilience-gap share), people share on a
    # log scale of the metro population: log10(pop / 0.5M) / log10(25M / 0.5M), clipped to 0-1
    share = math.log10(2_000_000 / 500_000) / math.log10(50)  # 0.354
    assert scores["alpha"].priority == round(57.279 * (0.6 + 0.25 * share + 0.15 * 0.4), 1) == 42.9
    bravo_share = math.log10(20_000_000 / 500_000) / math.log10(50)  # 0.943: no hub reaches the 25M cap
    assert scores["bravo"].priority == round(33.359 * (0.6 + 0.25 * bravo_share + 0.15 * 0.8), 1) == 31.9
    assert scores["bravo"].priority_band == "low"
    assert scores["charlie"].priority == 61.5  # 100 * (0.6 + 0 + 0.015): 0.5M people, share 0
    people = scores["alpha"].priority_signals[1]
    assert (people.raw, people.cap, people.normalized) == (2_000_000, 25_000_000, round(100 * share, 2))
    assert "metro" in people.name and "log10(pop / 0.5M) / log10(25M / 0.5M)" in people.note
    sig = scores["alpha"].priority_signals
    assert [s.weight for s in sig] == [0.6, 0.25, 0.15]
    assert sum(s.contribution for s in sig) == pytest.approx(scores["alpha"].priority, abs=0.05)


def test_priority_is_zero_without_exposure():
    assert scoring._priority(0.0, {"POPULATION": 10_000_000, "RESL_SCORE": 0}, DEFAULT_CONFIG, 20_000_000)[0] == 0.0


def test_people_share_linear_alternative():
    cfg = ScoringConfig(people_scale="linear")
    alpha = scoring.score_all(HUBS, SNAPSHOT, cfg)["alpha"]
    assert alpha.priority == round(57.279 * (0.6 + 0.25 * 0.08 + 0.15 * 0.4), 1)  # 2M / 25M
    assert [scoring.people_share(p) for p in (250_000, 500_000, 25_000_000, 40_000_000)] == [0.0, 0.0, 1.0, 1.0]
    assert DEFAULT_CONFIG.people_cap == 25_000_000


def test_people_fields_use_metro_population(scores):
    a = scores["alpha"]
    assert (a.metro_name, a.people_served) == ("Alpha Metro", 2_000_000)
    assert a.people_days_m == round(2.0 * 14.31974, 1)  # people x typical days / 1e6
    assert a.people_days_bad_year_m == pytest.approx(2.0 * a.bad_year_days, abs=0.1)


def test_missing_metro_population_falls_back_to_county():
    snap = scoring.Snapshot(nri=SNAPSHOT.nri, weather=SNAPSHOT.weather, population=None)
    a = scoring.score_all(HUBS, snap)["alpha"]
    assert a.people_served == 2_500_000 and a.metro_name == ""  # county POPULATION
    assert "county population" in a.priority_signals[1].note


def test_rank_by_people_impact(scores):
    r = scoring.rank(scores, HUBS, "people_impact")
    assert [i.hub_id for i in r.items] == ["bravo", "alpha", "delta", "charlie"]  # 166.8, 28.6, 28.6, 18.0
    assert [i.value for i in r.items] == [scores[i.hub_id].people_days_m for i in r.items]
    assert all(i.band is None for i in r.items)
    with pytest.raises(ValueError):
        scoring.rank(scores, HUBS, "people_impact", hazard="flood")


def test_scoring_version_names_this_formula():
    assert scoring.SCORING_VERSION == "v4-metro-2025"


def test_provenance_helper_reads_the_committed_file():
    p = scoring.provenance()
    assert set(p["sources"]) == {"fema_nri", "open_meteo", "census_population", "omb_delineations", "nws_alerts"}
    assert p["sources"]["census_population"]["period"] == "July 1, 2025 estimate"
    assert p["sources"]["open_meteo"]["period"] == "2015-01-01 to 2025-12-31"


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
    assert (rows[1].metro_name, rows[1].people_served, rows[1].people_days_m) == ("Alpha Metro", 2_000_000, 28.6)


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
        ("charlie", 61.5), ("bravo", 34.7), ("alpha", 34.3), ("delta", 34.3)]
    assert [(p.hub_id, p.priority_per_million) for p in r.per_million_ranking] == [("alpha", 17.15), ("bravo", 3.47)]
    assert r.inputs_echo == inputs
    assert "analyst-supplied" in r.note
    assert "hurricane 0.4" in r.note and "winter 0.2" in r.note  # 0.5 / 1.25 and 0.25 / 1.25


def test_what_if_without_inputs_matches_base_priority(scores):
    r = scoring.what_if(HUBS, SNAPSHOT, WhatIfInput())
    assert [(i.hub_id, i.value) for i in r.ranking] == [
        (i.hub_id, i.value) for i in scoring.rank(scores, HUBS, "priority").items]
    assert r.per_million_ranking is None
    assert r.rank_changes == []


def test_what_if_rank_changes_list_exactly_the_hubs_that_moved(scores):
    base = {i.hub_id: i.rank for i in scoring.rank(scores, HUBS, "priority").items}
    r = scoring.what_if(HUBS, SNAPSHOT, WhatIfInput.model_validate({"family_weights": {"hurricane": 0.5}}))
    moved = {i.hub_id: (base[i.hub_id], i.rank) for i in r.ranking if base[i.hub_id] != i.rank}
    assert moved  # this weight change reorders the fixture hubs
    assert {c.hub_id: (c.from_rank, c.to_rank) for c in r.rank_changes} == moved
    assert [c.to_rank for c in r.rank_changes] == sorted(c.to_rank for c in r.rank_changes)


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
    assert (s["newark"].metro_name, s["newark"].people_served) == ("New York-Newark-Jersey City, NY-NJ", 20112448)
    assert snap.population["year"] == 2025
    assert max(p["population"] for p in snap.population["hubs"].values()) < DEFAULT_CONFIG.people_cap  # no hub clips
    # bands follow the displayed (rounded) value: LA winter is 1.97 days, shown as 2.0, so medium
    assert (s["los_angeles"].families["winter"].days_per_year, s["los_angeles"].families["winter"].band) == (2.0, "medium")


# (expected days, bad-year TVaR95 days, priority) from the reviewed run; spec section 6 quotes these
REGRESSION = {
    "minneapolis": (27.6, 38.7, 73.2),
    "chicago": (18.1, 29.1, 60.0),
    "newark": (15.0, 35.4, 56.7),
    "houston": (10.5, 38.2, 37.8),
    "miami": (7.8, 42.8, 26.5),
    "los_angeles": (3.7, 8.4, 13.8),
    "phoenix": (1.6, 7.2, 5.5),
}


def test_coastal_flood_without_exposed_area_uses_the_default_share():
    import copy

    nri = copy.deepcopy(SNAPSHOT.nri)
    nri["counties"]["00002"]["CFLD_EXP_AREA"] = None
    snap = scoring.Snapshot(nri=nri, weather=SNAPSHOT.weather)
    coastal = _signal(scoring.score_all(HUBS, snap)["bravo"], "flood", "coastal flood")
    assert coastal.normalized == pytest.approx(2 * 2 * 0.0405)
    assert "default share 4.05%" in coastal.note


# ---------- observed history at the hub point (hub_history) ----------
# alpha every year: winter Jan 1-8 (8 days), heavy rain on 3 days in April, high gusts on 2 days in July.


def test_hub_history_counts_each_calendar_year():
    h = scoring.hub_history(HUBS, SNAPSHOT, "alpha")
    assert (h.hub_id, h.name, h.start_year, h.end_year) == ("alpha", "Alpha Hub", 2015, 2025)
    assert [y.year for y in h.years] == list(range(2015, 2026))
    y = h.years[0]
    assert y.days == {"winter": 8.0, "flood": 3.0, "hurricane": 0.0, "severe_storm": 2.0}
    assert y.total == 13.0
    assert h.data_as_of == "2026-11-17"


def test_hub_history_month_averages_and_peaks():
    h = scoring.hub_history(HUBS, SNAPSHOT, "alpha")
    by_month = {m.month: m for m in h.months}
    assert sorted(by_month) == list(range(1, 13))
    assert by_month[1].days["winter"] == 8.0 and by_month[1].total == 8.0
    assert by_month[4].days["flood"] == 3.0
    assert by_month[7].days["severe_storm"] == 2.0
    assert by_month[10].total == 0.0
    assert h.peak_months == [1, 4, 7]  # most first; only months with any disruption


def test_hub_history_worst_year_and_ties():
    import copy

    weather = copy.deepcopy(SNAPSHOT.weather)
    s = weather["hubs"]["alpha"]
    for day in ("2019-02-01", "2019-02-02", "2019-11-30"):
        s["snowfall_sum"][s["time"].index(day)] = 8.0
    snap = scoring.Snapshot(nri=SNAPSHOT.nri, weather=weather)
    h = scoring.hub_history(HUBS, snap, "alpha")
    assert h.worst_year == 2019
    assert {y.year: y.total for y in h.years}[2019] == 16.0
    assert scoring.hub_history(HUBS, SNAPSHOT, "alpha").worst_year == 2015  # all years equal: earliest
    feb = {m.month: m for m in h.months}[2]
    assert feb.days["winter"] == pytest.approx(2 / 11, abs=0.05)  # 2 days in 11 years, one decimal


def test_hub_history_counts_a_day_once_per_family():
    import copy

    weather = copy.deepcopy(SNAPSHOT.weather)
    s = weather["hubs"]["bravo"]
    i = s["time"].index("2020-03-15")
    s["snowfall_sum"][i], s["temperature_2m_min"][i], s["wind_gusts_10m_max"][i] = 6.0, -20.0, 90.0
    snap = scoring.Snapshot(nri=SNAPSHOT.nri, weather=weather)
    y2020 = {y.year: y for y in scoring.hub_history(HUBS, snap, "bravo").years}[2020]
    assert y2020.days["winter"] == 1.0  # snow and cold on the same day: one winter day
    assert y2020.days["severe_storm"] == 2.0  # the usual gust day + this one
    assert y2020.total == 1.0 + 5.0 + 2.0  # the same day counts for winter and for severe storm


def test_hub_history_thresholds_come_from_the_scoring_config():
    h = scoring.hub_history(HUBS, SNAPSHOT, "alpha")
    assert h.thresholds == {
        "winter": "snow >= 5 cm or min temp <= -18 °C",
        "flood": "precipitation >= 50 mm",
        "severe_storm": "max gust >= 75 km/h",
        "hurricane": "not observable in daily weather data (see the hurricane 10-year probability)",
    }
    cfg = ScoringConfig(snow_cm=10)
    h10 = scoring.hub_history(HUBS, SNAPSHOT, "alpha", cfg)
    assert h10.thresholds["winter"] == "snow >= 10 cm or min temp <= -18 °C"
    assert h10.years[0].days["winter"] == 8.0  # snow days are 6 cm, but the cold days still count
    # the KPI's observed signal uses the same rule: its per-year average equals the history's
    obs = _signal(scoring.score_all(HUBS, SNAPSHOT)["alpha"], "winter", "observed").raw
    assert obs == pytest.approx(sum(y.days["winter"] for y in h.years) / (4018 / 365.25), abs=1e-3)


def test_hub_history_note_and_unknown_hub():
    h = scoring.hub_history(HUBS, SNAPSHOT, "alpha")
    assert "hurricanes are not captured" in h.note and "ERA5" in h.note
    with pytest.raises(DataUnavailable):
        scoring.hub_history(HUBS, SNAPSHOT, "nowhere")


def test_rank_total_counts_matching_hubs_before_top_n(scores):
    everyone = scoring.rank(scores, HUBS, "priority")
    assert everyone.total == len(HUBS) == len(everyone.items)
    top_one = scoring.rank(scores, HUBS, "priority", top_n=1)
    assert len(top_one.items) == 1 and top_one.total == len(HUBS)
    midwest = scoring.rank(scores, HUBS, "priority", region="Midwest", top_n=15)
    assert midwest.total == len(midwest.items) == 1


def test_rank_by_people_served(scores):
    r = scoring.rank(scores, HUBS, "people_served", top_n=2)
    assert [(i.hub_id, i.value) for i in r.items] == [("bravo", 20_000_000.0), ("alpha", 2_000_000.0)]
    assert r.total == 4 and all(i.band is None for i in r.items)
    with pytest.raises(ValueError):
        scoring.rank(scores, HUBS, "people_served", hazard="winter")
