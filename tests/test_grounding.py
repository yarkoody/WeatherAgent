from app.grounding import ToolOutput, check, drop_ungrounded_figures, numbers_in_text
from app.schemas import AgentAnswer, Figure


def fig(value, hub="denver", tool="weather_stat", field="value", family=None, label="snow days 2025"):
    return Figure(hub_id=hub, label=label, value=value, unit="%", source_tool=tool, source_field=field, family=family)


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


WEATHER = ToolOutput(
    "weather_stat",
    {
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
    },
)

THRESHOLDS = {"medium_from": 35.0, "high_from": 60.0}
RANKING = ToolOutput(
    "rank_hubs",
    {
        "kind": "exposure",
        "hazard": "overall",
        "region": None,
        "items": [
            {"rank": 1, "hub_id": "miami", "name": "Miami", "value": 71.2, "band": "high"},
            {"rank": 2, "hub_id": "houston", "name": "Houston", "value": 66.0, "band": "high"},
            {"rank": 3, "hub_id": "chicago", "name": "Chicago", "value": 52.4, "band": "medium"},
        ],
        "band_thresholds": THRESHOLDS,
        "data_as_of": "2026-11-17",
    },
)

MIAMI = ToolOutput(
    "get_hub_risk",
    {
        "hub_id": "miami",
        "exposure": 48.0,
        "priority": 25.6,
        "hurricane_10yr_probability_pct": 41.0,
        "families": {
            "hurricane": {"family": "hurricane", "days_per_year": 2.1, "bad_year_days": 9.4},
            "winter": {"family": "winter", "days_per_year": 0.0, "bad_year_days": 0.0},
        },
        "family_weights": {"hurricane": 30.0, "winter": 0.0},
        "band_thresholds": {**THRESHOLDS, "high_from_days": 15.0},
        "data_as_of": "2026-11-17",
    },
)


# ---------- metric binding: tool + hub + family + field ----------


def test_value_of_another_field_fails_reproduced_case():
    # 25.6 is Miami's priority, not its hurricane probability
    a = answer("Miami's hurricane probability is 25.6%.", [fig(25.6, "miami", "get_hub_risk", "hurricane_10yr_probability_pct")])
    errors = check(a, [MIAMI], None)
    assert len(errors) == 1 and "hurricane_10yr_probability_pct" in errors[0] and "41" in errors[0]


def test_correct_field_passes():
    a = answer("Miami's hurricane probability is 41%.", [fig(41.0, "miami", "get_hub_risk", "hurricane_10yr_probability_pct")])
    assert check(a, [MIAMI], None) == []
    assert check(answer("", [fig(25.6, "miami", "get_hub_risk", "priority")]), [MIAMI], None) == []


def test_wrong_source_tool_fails():
    errors = check(answer("", [fig(25.6, "miami", "weather_stat", "priority")]), [MIAMI], None)
    assert len(errors) == 1 and "weather_stat" in errors[0]


def test_family_must_match():
    assert check(answer("", [fig(2.1, "miami", "get_hub_risk", "days_per_year", "hurricane")]), [MIAMI], None) == []
    assert check(answer("", [fig(2.1, "miami", "get_hub_risk", "days_per_year", "winter")]), [MIAMI], None) != []
    assert check(answer("", [fig(2.1, "miami", "get_hub_risk", "days_per_year", None)]), [MIAMI], None) != []
    # a family-keyed dict: the field is the dict's name, the family its key
    assert check(answer("", [fig(30.0, "miami", "get_hub_risk", "family_weights", "hurricane")]), [MIAMI], None) == []


def test_ranking_items_bind_value_to_their_hub():
    assert check(answer("", [fig(66.0, "houston", "rank_hubs", "value")]), [RANKING], None) == []
    assert check(answer("", [fig(71.2, "houston", "rank_hubs", "value")]), [RANKING], None) != []


def test_per_million_ranking():
    result = ToolOutput(
        "what_if",
        {
            "kind": "priority",
            "inputs_echo": {"family_weights": {"flood": 0.4}, "upgrade_costs": [{"hub_id": "chicago", "cost_musd": 40.0}]},
            "ranking": [{"rank": 1, "hub_id": "chicago", "name": "Chicago", "value": 52.4, "band": "medium"}],
            "per_million_ranking": [
                {"rank": 1, "hub_id": "chicago", "name": "Chicago", "priority": 52.4, "cost_musd": 40.0, "priority_per_million": 1.31},
                {"rank": 2, "hub_id": "dallas", "name": "Dallas", "priority": 44.9, "cost_musd": 60.0, "priority_per_million": 0.75},
            ],
            "note": "Inputs are analyst-supplied.",
            "data_as_of": "2026-11-17",
        },
    )
    assert check(answer("", [fig(1.31, "chicago", "what_if", "priority_per_million")]), [result], None) == []
    assert check(answer("", [fig(1.31, "dallas", "what_if", "priority_per_million")]), [result], None) != []
    # analyst inputs are hub-less figures
    assert check(answer("", [fig(0.4, None, "what_if", "family_weights", "flood")]), [result], None) == []


def test_history_fields_bind_to_the_history_hub():
    history = ToolOutput(
        "get_hub_history",
        {
            "hub_id": "houston",
            "name": "Houston",
            "start_year": 2015,
            "end_year": 2025,
            "years": [{"year": 2024, "days": {"winter": 0.0, "flood": 3.0}, "total": 7.0}],
            "months": [{"month": 8, "days": {"flood": 1.2}, "total": 1.9}],
            "worst_year": 2024,
            "thresholds": {"flood": "precipitation >= 50 mm"},
            "data_as_of": "2026-11-17",
        },
    )
    assert check(answer("", [fig(7.0, "houston", "get_hub_history", "total")]), [history], None) == []
    assert check(answer("", [fig(3.0, "houston", "get_hub_history", "days", "flood")]), [history], None) == []
    assert check(answer("", [fig(3.0, "houston", "get_hub_history", "total")]), [history], None) != []
    assert check(answer("", [fig(7.0, "dallas", "get_hub_history", "total")]), [history], None) != []
    assert check(answer("", [fig(50, "houston", "get_hub_history", "thresholds", "flood")]), [history], None) == []


def test_hubless_figures_match_band_thresholds_or_hubless_fields_only():
    assert check(answer("", [fig(60, None, "get_hub_risk", "high_from")]), [MIAMI], None) == []
    assert check(answer("", [fig(15.0, None, "get_hub_risk", "high_from_days")]), [MIAMI], None) == []
    # a hub's own field is not a general figure
    assert check(answer("", [fig(25.6, None, "get_hub_risk", "priority")]), [MIAMI], None) != []
    # a hub's own band thresholds are citable for that hub too
    assert check(answer("", [fig(60, "miami", "get_hub_risk", "high_from")]), [MIAMI], None) == []


def test_prior_results_count_when_named():
    # history results are passed the same way as this turn's
    assert check(answer("", [fig(66.0, "houston", "rank_hubs", "value")]), [("rank_hubs", RANKING.result)], None) == []


# ---------- values, text numbers and tolerance ----------


def test_figures_matching_tool_values_pass():
    # 11.83 is within 0.05 of 11.8; 365.0 matches the int 365 exactly
    figs = [fig(11.83), fig(43, field="numerator"), fig(365, field="denominator")]
    assert check(answer("Denver had 11.8% snow days (43 of 365).", figs), [WEATHER], None) == []


def test_figure_tolerance_is_relative_for_large_values():
    big = ToolOutput("get_hub_risk", {"population": 2607218})
    assert check(answer("", [fig(2607218 + 13000, None, "get_hub_risk", "population")]), [big], None) == []  # 0.5%
    assert check(answer("", [fig(2607218 + 14000, None, "get_hub_risk", "population")]), [big], None) != []


def test_numbers_inside_tool_strings_are_collected():
    figs = [fig(-10, field="definition", label="threshold"), fig(0.1, field="definition", label="snow cutoff")]
    assert check(answer("Freezing means below -10 °C.", figs), [WEATHER], None) == []


def test_band_thresholds_citable():
    figs = [fig(60, None, "rank_hubs", "high_from"), fig(35, None, "rank_hubs", "medium_from")]
    assert check(answer("High starts at 60 and medium at 35.", figs), [RANKING], None) == []


def test_invented_figure_fails():
    errors = check(answer("Snow days were 43.5%.", [fig(43.5)]), [WEATHER], None)
    assert len(errors) == 1 and "43.5" in errors[0]


def test_number_in_text_not_in_figures_fails():
    errors = check(answer("Denver had 43% snow days.", [fig(11.8)]), [WEATHER], None)
    assert len(errors) == 1 and "43" in errors[0]


def test_years_and_small_counts_exempt():
    assert check(answer("In 2025, the top 3 of 15 hubs, over 2015-2025.", []), [], None) == []
    # a percentage or a decimal is never exempt
    assert check(answer("About 5% of days.", []), [], None) != []
    assert check(answer("Score 2.5 here.", []), [], None) != []


def test_percent_and_commas_parsed():
    assert numbers_in_text("11.8% and 2,607,218 people, -3.5 °C, top-3") == [11.8, 2607218.0, -3.5, 3.0]
    pop = ToolOutput("get_hub_risk", {"population": 2607218})
    a = answer("Population 2,607,218; snow 11.8%.", [fig(2607218, None, "get_hub_risk", "population"), fig(11.8)])
    assert check(a, [WEATHER, pop], None) == []


def test_drop_ungrounded_figures_keeps_only_matching():
    a = answer("x", [fig(11.8), fig(99.9), fig(11.8, field="numerator")])
    assert [(f.value, f.source_field) for f in drop_ungrounded_figures(a, [WEATHER]).figures] == [(11.8, "value")]


def test_iso_dates_in_text_are_not_figures():
    assert check(answer("Data as of 2026-11-17 (fetched 2026-11-17T08:30:00Z).", []), [WEATHER], None) == []


def test_tool_errors_and_iso_dates_are_not_citable():
    error = ToolOutput("rank_hubs", {"error": "Invalid top_n.", "retryable": True, "hint": "top_n must be 1 to 99."})
    assert check(answer("", [fig(99, None, "rank_hubs", "hint")]), [error], None) != []
    dated = ToolOutput("get_hub_risk", {"data_as_of": "2026-11-17", "fetched_at": "2026-11-17T08:17:00Z"})
    assert check(answer("", [fig(17, None, "get_hub_risk", "data_as_of")]), [dated], None) != []
    assert check(answer("", [fig(17, None, "get_hub_risk", "fetched_at")]), [dated], None) != []


def test_text_numbers_in_assumptions_and_uncertainty_need_figures():
    weights = ToolOutput("what_if", {"inputs_echo": {"family_weights": {"flood": 0.4}}})
    a = answer("", [], assumptions=["Flood weight set to 0.4 by the analyst."], uncertainty="Uses 36 months of weather.")
    errors = check(a, [weights], None)
    assert len(errors) == 2
    assert any("assumptions" in e and "0.4" in e for e in errors) and any("uncertainty" in e and "36" in e for e in errors)
    ok = answer("", [fig(0.4, None, "what_if", "family_weights", "flood")], assumptions=["Flood weight 0.4."], uncertainty="Since 2015.")
    assert check(ok, [weights], None) == []


# ---------- rankings ----------


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
    comparison = ToolOutput(
        "compare_hubs",
        {
            "hubs": [{"hub_id": "dallas", "exposure": 40.0, "priority": 55.0}, {"hub_id": "houston", "exposure": 66.0, "priority": 50.0}],
            "hazards": ["overall"],
            "data_as_of": "2026-11-17",
        },
    )
    assert check(answer("", ranking=["houston", "dallas"]), [comparison], None) == []
    assert check(answer("", ranking=["dallas", "houston"]), [comparison], None) == []  # by priority


def test_ranking_may_be_an_ordered_subset_or_reversed():
    assert check(answer("", ranking=["chicago", "houston"]), [RANKING], None) == []
    assert check(answer("", ranking=["miami", "chicago"]), [RANKING], None) == []
    assert check(answer("", ranking=["miami", "miami"]), [RANKING], None) != []
    assert check(answer("", ranking=["miami", "denver"]), [RANKING], None) != []


# ---------- compact numbers in text ("472K", "2.6M", "1.2 billion") ----------

POP = {"hub_id": "dallas", "population": 2607218, "small": 472113, "round": 1000000, "near": 1050000,
       "big": 1234567890, "gust": 60.0, "cost_musd": 40.0}
POP_OUT = ToolOutput("get_hub_risk", POP)


def pop_answer(text, *values):
    field = {v: k for k, v in POP.items()}
    figures = [Figure(hub_id="dallas", label="n", value=v, unit="people", source_tool="get_hub_risk", source_field=field[v], family=None)
               for v in values]
    return AgentAnswer(answer=text, hubs=["dallas"], ranking=None, figures=figures,
                       assumptions=[], uncertainty="", data_available=True, in_scope=True)


def test_compact_thousands_match_within_displayed_precision():
    assert check(pop_answer("Serves about 472K people.", 472113), [POP_OUT], None) == []
    assert check(pop_answer("Serves about 471K people.", 472113), [POP_OUT], None) != []


def test_compact_millions_match_within_displayed_precision():
    assert check(pop_answer("Serves 2.6M people.", 2607218), [POP_OUT], None) == []
    assert check(pop_answer("Serves 2.6 million people.", 2607218), [POP_OUT], None) == []
    assert check(pop_answer("Serves 2.7M people.", 2607218), [POP_OUT], None) != []


def test_compact_one_significant_digit_needs_an_exact_value():
    assert check(pop_answer("About 1 million people.", 1050000), [POP_OUT], None) != []
    assert check(pop_answer("Exactly 1M people.", 1000000), [POP_OUT], None) == []


def test_compact_wrong_magnitude_fails_and_is_not_exempt():
    # "3" alone would be an exempt small count; "3M" is a figure and must match one.
    errors = check(pop_answer("About 3M people.", 2607218), [POP_OUT], None)
    assert len(errors) == 1 and "3M" in errors[0]


def test_compact_billions():
    assert check(pop_answer("1.2 billion in total.", 1234567890), [POP_OUT], None) == []
    assert check(pop_answer("1.2bn in total.", 1234567890), [POP_OUT], None) == []


def test_unit_letters_are_not_suffixes():
    assert check(pop_answer("Gusts of 60 km/h.", 60.0), [POP_OUT], None) == []


def test_usd_millions_still_match_the_plain_value():
    # what_if costs are in USD millions: "$40M" cites cost_musd 40.
    assert check(pop_answer("Chicago costs $40M.", 40.0), [POP_OUT], None) == []


def test_cites_compact_helper():
    from app.grounding import cites_compact

    assert cites_compact("Dallas serves about 2.6M people.", 2607218)
    assert not cites_compact("Dallas serves 2,607,218 people.", 2607218)  # exact, not compact
    assert not cites_compact("Dallas serves 3M people.", 2607218)


def test_no_data_answer_must_not_cite_figures():
    no_data = answer("I don't have Denver's 2026 snow days; 2025 had 11.8%.", [fig(11.8)]).model_copy(update={"data_available": False})
    errors = check(no_data, [WEATHER], None)
    assert len(errors) == 1 and "data_available" in errors[0]
    assert drop_ungrounded_figures(no_data, [WEATHER]).figures == []
    clean = answer("I don't have Denver's 2026 snow days.", []).model_copy(update={"data_available": False})
    assert check(clean, [WEATHER], None) == []


def test_numbers_inside_identifiers_are_not_figures():
    # "About this system" answers name the model and versions; those digits are not data
    meta = answer("Answers come from gpt-6.1-sol via the AI SDK, scored with v2-tvar on Open-Meteo ERA5 data.", [])
    assert check(meta, [], None) == []
    # real numbers still need figures
    assert check(answer("Freezing below -10 °C.", []), [], None) != []
    assert check(answer("Snow on 11.8% of days in sol-like years.", []), [], None) != []


def test_the_0_to_100_scale_is_not_a_figure():
    assert check(answer("Exposure is a 0-100 index (0 to 100).", []), [], None) == []
    assert check(answer("Priority is 100.", []), [], None) != []
