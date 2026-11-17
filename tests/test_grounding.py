from app.grounding import check, drop_ungrounded_figures, numbers_in_text
from app.schemas import AgentAnswer, Figure


def fig(value, hub="denver", tool="weather_stat", label="snow days 2025"):
    return Figure(hub_id=hub, label=label, value=value, unit="%", source_tool=tool)


def answer(text="", figures=(), ranking=None, assumptions=(), uncertainty=""):
    return AgentAnswer(
        answer=text,
        hubs=["denver"],
        ranking=ranking,
        figures=list(figures),
        assumptions=list(assumptions),
        uncertainty=uncertainty,
        data_available=True,
        in_scope=True,
    )


WEATHER = {
    "hub_id": "denver",
    "metric": "snow_days_pct",
    "year": 2025,
    "value": 11.8,
    "numerator": 43,
    "denominator": 365,
    "unit": "%",
    "definition": "Share of days with snowfall >= 0.1 cm and min temperature below -10 °C",
    "source": "Open-Meteo",
    "data_as_of": "2026-11-17",
}

RANKING = {
    "kind": "exposure",
    "hazard": "overall",
    "region": None,
    "items": [
        {"rank": 1, "hub_id": "miami", "name": "Miami", "value": 71.2, "band": "high"},
        {"rank": 2, "hub_id": "houston", "name": "Houston", "value": 66.0, "band": "high"},
        {"rank": 3, "hub_id": "chicago", "name": "Chicago", "value": 52.4, "band": "medium"},
    ],
    "band_thresholds": {"medium_from": 35.0, "high_from": 60.0},
    "data_as_of": "2026-11-17",
}


def test_figures_matching_tool_values_pass():
    # 11.83 is within 0.05 of 11.8; 365.0 matches the int 365 exactly
    a = answer("Denver had 11.8% snow days (43 of 365).", [fig(11.83), fig(43), fig(365)])
    assert check(a, [WEATHER], None) == []


def test_figure_tolerance_is_relative_for_large_values():
    big = {"population": 2607218}
    assert check(answer("", [fig(2607218 + 13000, hub=None)]), [big], None) == []  # 0.5%
    assert check(answer("", [fig(2607218 + 14000, hub=None)]), [big], None) != []


def test_numbers_inside_tool_strings_are_collected():
    a = answer("Freezing means below -10 °C.", [fig(-10, label="threshold"), fig(0.1, label="snow cutoff")])
    assert check(a, [WEATHER], None) == []


def test_band_thresholds_citable():
    a = answer("High starts at 60 and medium at 35.", [fig(60, hub=None, label="high from"), fig(35, hub=None, label="medium from")])
    assert check(a, [RANKING], None) == []


def test_invented_figure_fails():
    errors = check(answer("Snow days were 43.5%.", [fig(43.5)]), [WEATHER], None)
    assert len(errors) == 1 and "43.5" in errors[0]


def test_number_in_text_not_in_figures_fails():
    errors = check(answer("Denver had 43% snow days.", [fig(11.8)]), [WEATHER], None)
    assert len(errors) == 1 and "43" in errors[0]


def test_years_and_small_counts_exempt():
    a = answer("In 2025, the top 3 of 15 hubs, over 2015-2025.", [])
    assert check(a, [], None) == []
    # a percentage or a decimal is never exempt
    assert check(answer("About 5% of days.", []), [], None) != []
    assert check(answer("Score 2.5 here.", []), [], None) != []


def test_ranking_mismatch_fails():
    good = answer("", ranking=["miami", "houston"])
    assert check(good, [RANKING], None) == []
    assert check(good, [RANKING], ["miami", "houston", "chicago"]) == []
    bad = answer("", ranking=["houston", "miami", "chicago"])
    assert check(bad, [RANKING], None) != []
    assert check(bad, [RANKING], ["miami", "houston", "chicago"]) != []
    # a ranking with no ranking tool result to back it fails
    assert check(answer("", ranking=["miami"]), [WEATHER], None) != []


def test_ranking_from_comparison_is_accepted():
    comparison = {
        "hubs": [
            {"hub_id": "dallas", "exposure": 40.0, "priority": 55.0},
            {"hub_id": "houston", "exposure": 66.0, "priority": 50.0},
        ],
        "hazards": ["overall"],
        "data_as_of": "2026-11-17",
    }
    assert check(answer("", ranking=["houston", "dallas"]), [comparison], None) == []
    assert check(answer("", ranking=["dallas", "houston"]), [comparison], None) == []  # by priority


def test_percent_and_commas_parsed():
    assert numbers_in_text("11.8% and 2,607,218 people, -3.5 °C, top-3") == [11.8, 2607218.0, -3.5, 3.0]
    a = answer("Population 2,607,218; snow 11.8%.", [fig(2607218, hub=None, label="population"), fig(11.8)])
    assert check(a, [WEATHER, {"population": 2607218}], None) == []


def test_drop_ungrounded_figures_keeps_only_matching():
    a = answer("x", [fig(11.8), fig(99.9)])
    kept = drop_ungrounded_figures(a, [WEATHER])
    assert [f.value for f in kept.figures] == [11.8]


def test_iso_dates_in_text_are_not_figures():
    a = answer("Data as of 2026-11-17 (fetched 2026-11-17T08:30:00Z).", [])
    assert check(a, [WEATHER], None) == []


HOUSTON = {"hub_id": "houston", "exposure": 66.0, "priority": 58.2, "band_thresholds": {"medium_from": 35.0, "high_from": 60.0}}
DALLAS = {"hub_id": "dallas", "exposure": 41.7, "priority": 44.9}


def test_figure_for_wrong_hub_fails():
    results = [{"hubs": [HOUSTON, DALLAS], "hazards": ["overall"], "data_as_of": "2026-11-17"}]
    errors = check(answer("Houston exposure 41.7.", [fig(41.7, hub="houston", label="exposure")]), results, None)
    assert len(errors) == 1 and "houston" in errors[0]
    assert check(answer("Houston exposure 66.", [fig(66.0, hub="houston", label="exposure")]), results, None) == []
    assert check(answer("", [fig(41.7, hub=None, label="dallas exposure")]), results, None) == []
    # a hub's own band thresholds are citable for that hub
    assert check(answer("", [fig(60, hub="houston", label="high from")]), results, None) == []


def test_tool_errors_and_iso_dates_are_not_citable():
    error = {"error": "Invalid top_n.", "retryable": True, "hint": "top_n must be 1 to 99."}
    assert check(answer("", [fig(99, hub=None)]), [error], None) != []
    assert check(answer("", [fig(17, hub=None)]), [{"data_as_of": "2026-11-17"}], None) != []
    assert check(answer("", [fig(17, hub=None)]), [{"fetched_at": "2026-11-17T08:17:00Z"}], None) != []


def test_text_numbers_in_assumptions_and_uncertainty_need_figures():
    a = answer("", [], assumptions=["Flood weight set to 0.4 by the analyst."], uncertainty="Uses 36 months of weather.")
    errors = check(a, [{"family_weights": {"flood": 0.4}}], None)
    assert len(errors) == 2
    assert any("assumptions" in e and "0.4" in e for e in errors) and any("uncertainty" in e and "36" in e for e in errors)
    ok = answer("", [fig(0.4, hub=None, label="flood weight")], assumptions=["Flood weight 0.4."], uncertainty="Since 2015.")
    assert check(ok, [{"family_weights": {"flood": 0.4}}], None) == []


def test_ranking_may_be_an_ordered_subset_or_reversed():
    lowest_two = answer("", ranking=["chicago", "houston"])
    assert check(lowest_two, [RANKING], None) == []
    filtered = answer("", ranking=["miami", "chicago"])
    assert check(filtered, [RANKING], None) == []
    assert check(answer("", ranking=["miami", "miami"]), [RANKING], None) != []
    assert check(answer("", ranking=["miami", "denver"]), [RANKING], None) != []
