"""Suggested follow-up questions are built by code from the turn, so each one is answerable and in scope."""

from app.followups import suggest_follow_ups
from app.schemas import AgentAnswer

NAMES = {"minneapolis": "Minneapolis", "chicago": "Chicago", "dallas": "Dallas", "houston": "Houston", "miami": "Miami"}


def answer(**kw) -> AgentAnswer:
    base = dict(answer="x", hubs=[], ranking=None, figures=[], assumptions=[], uncertainty="", data_available=True, in_scope=True)
    base.update(kw)
    return AgentAnswer(**base)


def test_after_a_ranking_suggests_why_compare_and_other_lens():
    out = suggest_follow_ups(answer(hubs=["minneapolis", "chicago"], ranking=["minneapolis", "chicago"]), ["rank_hubs"], NAMES, user_message="rank them")
    assert out == [
        "Why is Minneapolis ranked first?",
        "Compare Minneapolis and Chicago",
        "Show the bad-year ranking",
    ]


def test_after_a_bad_year_ranking_offers_the_typical_year():
    out = suggest_follow_ups(
        answer(hubs=["miami", "houston"], ranking=["miami", "houston"]), ["rank_hubs"], NAMES, used_bad_year=True
    )
    assert "Show the typical-year ranking" in out
    assert "Show the bad-year ranking" not in out


def test_after_one_hub_suggests_upgrades_alerts_and_rank():
    out = suggest_follow_ups(answer(hubs=["dallas"]), ["get_hub_risk"], NAMES)
    assert out == [
        "What upgrades would reduce Dallas's weather risk?",
        "Are there active weather alerts at Dallas?",
        "Where does Dallas rank among all hubs?",
    ]


def test_after_alerts_tool_does_not_suggest_alerts_again():
    out = suggest_follow_ups(answer(hubs=["dallas"]), ["get_active_alerts"], NAMES)
    assert all("alerts" not in s for s in out)


def test_after_a_comparison_suggests_drivers_and_bad_year():
    out = suggest_follow_ups(answer(hubs=["miami", "houston"]), ["compare_hubs"], NAMES)
    assert out == ["What drives Miami's risk?", "What drives Houston's risk?", "Which of them has the worse bad year?"]


def test_out_of_scope_or_no_data_falls_back_to_starter_questions():
    for a in (answer(in_scope=False), answer(data_available=False)):
        out = suggest_follow_ups(a, [], NAMES)
        assert len(out) == 3
        assert "Which hubs are most exposed to weather disruption?" in out


def test_never_repeats_the_users_own_question_and_caps_at_three():
    out = suggest_follow_ups(answer(hubs=["dallas"]), ["get_hub_risk"], NAMES, user_message="Are there active weather alerts at Dallas?")
    assert "Are there active weather alerts at Dallas?" not in out
    assert len(out) <= 3


def test_no_numbers_in_suggestions():
    out = suggest_follow_ups(answer(hubs=["minneapolis", "chicago"], ranking=["minneapolis", "chicago"]), ["rank_hubs"], NAMES)
    assert not any(ch.isdigit() for s in out for ch in s)


def test_unknown_hub_id_uses_the_id_rather_than_failing():
    out = suggest_follow_ups(answer(hubs=["atlantis"]), ["get_hub_risk"], NAMES)
    assert out[0].startswith("What upgrades would reduce atlantis")


def test_after_comparing_two_hubs_does_not_offer_the_same_comparison():
    """The comparison just answered ("Compare Dallas and Houston") is never offered again as "Ask next"."""
    out = suggest_follow_ups(
        answer(hubs=["dallas", "houston"], ranking=["houston", "dallas"]), ["compare_hubs"], NAMES,
        user_message="Compare the Dallas and Houston hubs on flood",
    )
    assert not any(s.startswith("Compare") for s in out)
    assert "What drives Dallas's risk?" in out
