"""JEV second opinion: an independent low/medium/high rating per hub and hazard family.

TypeSafe's JEV decision model gets only the raw signals of one hub (FEMA NRI annualized event
frequencies, observed day counts, county area), never our scores, indexes, bands, weights or
days-per-event assumptions, and not the hub's name. Its score (the expected rubric level, 0 = low to
2 = high) is scaled to 0-1, mapped to bands with the same cut-offs as our 0-100 index
(0.35 / 0.60) and compared with our family band.

It never feeds scores or rankings: it is a cross-check an analyst can review. One `evaluate`
call per hub asks four questions (one per family), so a full run is 15 calls. The TypeSafe
provider reads TYPESAFE_API_KEY from the environment; this module never reads or logs it.
"""

from __future__ import annotations

import asyncio
import re
import time
from datetime import datetime, timezone
from typing import Any

from app import scoring
from app.schemas import Band, Family, JevFamilyOpinion, JevHubOpinion, SecondOpinion, Signal

JEV_MODEL_ID = "jev-latest"
FAMILIES: tuple[Family, ...] = ("winter", "flood", "hurricane", "severe_storm")
MEDIUM_FROM, HIGH_FROM = 0.35, 0.60  # same cut-offs as the 0-100 index (35 / 60)
CONCURRENCY = 5
NOTE = ("Independent rating by TypeSafe's JEV decision model on the same raw signals. "
        "It does not affect scores or rankings; disagreements are worth an analyst's review.")

FAMILY_TEXT = {
    "winter": "winter weather (snow, ice storms, extreme cold)",
    "flood": "flooding (inland and coastal flooding, heavy rain)",
    "hurricane": "hurricanes and tropical storms",
    "severe_storm": "severe storms (tornadoes, strong wind, hail, high gusts)",
}
CONTEXT = (
    "Raw hazard signals for one US logistics distribution hub. FEMA National Risk Index values are annualized "
    "event frequencies for the hub's county (events per year; null means NRI has no value). Open-Meteo values are "
    "days per year observed at the hub location, averaged over 2023-2025. The county area is given because county "
    "event counts grow with county size."
)
CRITERIA = [
    "low: the signals show this hazard is rare or mild here; it would seldom disrupt the hub's operations.",
    "medium: the hazard occurs regularly here and would disrupt operations on several days in a typical year.",
    "high: the hazard is frequent or severe here and is a major, recurring cause of lost operating days.",
]
_MODEL_CHOICE = re.compile(r"\s*\(FEMA NRI,[^)]*\)")  # "(FEMA NRI, 0.5 days/event)" is our assumption, not data


def normalize_score(score: float, levels: int = len(CRITERIA)) -> float:
    """JEV's ScoreAnswer.score is the expected rubric level (sum of level x probability, levels 0..n-1),
    so 0 = low and 2 = high for three criteria. Divide by n-1 for a 0-1 fraction."""
    return min(max(score / (levels - 1), 0.0), 1.0)


def band_from_score(score: float) -> Band:
    """Band for a 0-1 fraction, with the same cut-offs as the 0-100 index."""
    if score >= HIGH_FROM:
        return "high"
    if score >= MEDIUM_FROM:
        return "medium"
    return "low"


def _raw_row(signal: Signal) -> dict[str, Any]:
    """Only what was measured: name, raw value, unit, source. No normalized value, weight or contribution."""
    source = signal.source
    if signal.unit == "days/year" and signal.note:
        source = f"{source}, {signal.note.split(';')[0]}"
    return {"signal": _MODEL_CHOICE.sub("", signal.name), "value": signal.raw, "unit": signal.unit, "source": source}


def hub_state(hub_score: Any, county: dict[str, Any]) -> dict[str, Any]:
    area = county.get("AREA")
    return {
        "context": CONTEXT,
        "county_area_sq_mi": round(area) if isinstance(area, (int, float)) else None,
        "signals_by_family": {f: [_raw_row(s) for s in hub_score.families[f].signals] for f in FAMILIES},
    }


def questions() -> dict[str, Any]:
    from ai.ops.experimental import ScoreQuestion

    return {
        f: ScoreQuestion(
            instructions=(
                f"Using only the signals under '{f}' in signals_by_family, rate how much {FAMILY_TEXT[f]} "
                "disrupts this logistics hub's operations: low, medium or high."
            ),
            criteria=list(CRITERIA),
        )
        for f in FAMILIES
    }


def default_model() -> Any:
    import ai
    from ai.providers.typesafe import TypeSafeProvider

    return ai.Model(id=JEV_MODEL_ID, provider=TypeSafeProvider())


async def _default_evaluate(model: Any, state: Any, qs: Any) -> Any:
    import ai

    return await ai.ops.experimental.evaluate(model, state, qs)


async def build_second_opinion(*, evaluate_fn=None, model=None, stats: list[dict] | None = None) -> SecondOpinion:
    """Rate every hub and family with JEV and compare with our bands.

    `evaluate_fn` and `model` are injectable for tests; `stats`, if given, receives one dict per
    JEV call (hub_id, latency_s, usage). Raises if a hub still fails after one retry.
    """
    evaluate_fn = evaluate_fn or _default_evaluate
    model = model if model is not None else default_model()
    hubs, snapshot = scoring.load_hubs(), scoring.load_snapshot()
    scores = scoring.score_all(hubs, snapshot)
    sem = asyncio.Semaphore(CONCURRENCY)
    model_ids: set[str] = set()  # the version the provider reports (e.g. jev-1.14.0), not the alias

    async def rate(hub) -> JevHubOpinion:
        s = scores[hub.id]
        state = hub_state(s, snapshot.nri["counties"].get(hub.county_fips, {}))
        async with sem:
            start = time.perf_counter()
            try:
                item = await evaluate_fn(model, state, questions())
            except Exception:
                item = await evaluate_fn(model, state, questions())  # one retry; a second failure propagates
            latency = round(time.perf_counter() - start, 2)
        if stats is not None:
            usage = getattr(item, "usage", None)
            stats.append({"hub_id": hub.id, "latency_s": latency,
                          "usage": usage.model_dump() if hasattr(usage, "model_dump") else usage})
        answers = item.value
        reported = ((getattr(item, "provider_metadata", None) or {}).get("typesafe") or {}).get("model")
        if reported:
            model_ids.add(reported)
        families = []
        for f in FAMILIES:
            jev_score = normalize_score(float(answers[f].score))
            ours = scoring.band(s.families[f].score)
            jev = band_from_score(jev_score)
            families.append(JevFamilyOpinion(family=f, jev_band=jev, jev_score_pct=round(jev_score * 100, 1),
                                             our_band=ours, agrees=jev == ours))
        agree = sum(f.agrees for f in families)
        return JevHubOpinion(hub_id=hub.id, name=hub.name, families=families, agree_count=agree, total=len(families))

    rated = await asyncio.gather(*(rate(h) for h in sorted(hubs, key=lambda h: h.id)))
    agree = sum(h.agree_count for h in rated)
    total = sum(h.total for h in rated)
    return SecondOpinion(
        model=", ".join(sorted(model_ids)) or getattr(model, "id", JEV_MODEL_ID),
        run_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        data_as_of=snapshot.data_as_of,
        hubs=list(rated),
        agree_count=agree,
        total=total,
        agreement_pct=round(100 * agree / total, 1) if total else 0.0,
        note=NOTE,
    )
