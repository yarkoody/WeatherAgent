"""Score-change alerts (bonus).

Recompute scores, compare with the committed baseline `data/snapshot/score_baseline.json`,
and report every hub whose exposure or priority moved by 5 points or more, or whose band
changed. Also reports active Severe or Extreme NWS alerts at the hubs. Delivery: a JSON
POST to ALERT_WEBHOOK_URL, or a line in logs/alerts.jsonl when no URL is set (or the
webhook fails).

    python -m app.alerts                       # fresh weather, rolling window as long as the scoring window
    python -m app.alerts --snapshot            # committed snapshot as is
    python -m app.alerts --demo-window 2015-2017   # snapshot rescored on another window (live demo)
    python -m app.alerts --update-baseline     # also replace the baseline with this run's scores

The baseline is a committed file, not SQLite, because Render's disk resets on deploy and the
scheduled job runs in GitHub Actions. It only changes on the first run or with --update-baseline.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Any

import httpx

from app.schemas import ScoreRow
from app.store import Store

ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = ROOT / "data" / "snapshot" / "score_baseline.json"
LOG_PATH = ROOT / "logs" / "alerts.jsonl"
POINTS_THRESHOLD = 5.0
BAND_HYSTERESIS = 2.0  # a band change alerts only when the new score is this far past the cut-off
BAD_YEAR_DAYS_THRESHOLD = 3.0
HURRICANE_PCT_THRESHOLD = 10.0
NWS_SEVERITIES = {"Severe", "Extreme"}
# Scoring config fields that hold the observed weather window (Track A's ScoringConfig).
WINDOW_FIELDS = ("observed_start", "observed_end")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def load_baseline(path: Path) -> dict[str, ScoreRow] | None:
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return {r["hub_id"]: ScoreRow.model_validate(r) for r in data["rows"]}


def write_baseline(path: Path, rows: list[ScoreRow], computed_at: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"computed_at": computed_at, "rows": [r.model_dump(mode="json") for r in sorted(rows, key=lambda r: r.hub_id)]}
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


_BAND_ORDER = ("low", "medium", "high")


def _band_change_is_clear(band_a: str, band_b: str, value: float) -> bool:
    """Hysteresis: the new score must be BAND_HYSTERESIS points past the cut-off it crossed.

    Stops a hub that hovers around a cut-off (59.7 -> 60.1 -> 59.8) from alerting on every run.
    """
    from app import scoring

    cut = {"medium": scoring.DEFAULT_CONFIG.medium_from, "high": scoring.DEFAULT_CONFIG.high_from}
    if _BAND_ORDER.index(band_b) > _BAND_ORDER.index(band_a):  # moved up: past the new band's lower cut-off
        return value >= cut[band_b] + BAND_HYSTERESIS
    upper = _BAND_ORDER[_BAND_ORDER.index(band_b) + 1]  # moved down: below the cut-off of the band above
    return value <= cut[upper] - BAND_HYSTERESIS


def compare(old: ScoreRow, new: ScoreRow) -> dict[str, Any] | None:
    """The change record for one hub, or None if nothing crossed a threshold."""
    reasons: list[tuple[str, str, float, float]] = []  # (metric, reason, old, new)
    for metric in ("exposure", "priority"):
        a, b = getattr(old, metric), getattr(new, metric)
        delta = round(b - a, 2)
        if abs(delta) >= POINTS_THRESHOLD:
            reasons.append((metric, f"{metric} {delta:+.1f} ({a:.1f} -> {b:.1f})", a, b))
        band_a, band_b = getattr(old, f"{metric}_band"), getattr(new, f"{metric}_band")
        if band_a != band_b and _band_change_is_clear(band_a, band_b, b):
            reasons.append((metric, f"{metric} band {band_a} -> {band_b} ({a:.1f} -> {b:.1f})", a, b))
    for metric, label, threshold, unit in (
        ("bad_year_days", "bad-year days", BAD_YEAR_DAYS_THRESHOLD, ""),
        ("hurricane_10yr_probability_pct", "hurricane 10-year probability", HURRICANE_PCT_THRESHOLD, " points"),
    ):
        a, b = getattr(old, metric), getattr(new, metric)
        delta = round(b - a, 2)
        if abs(delta) >= threshold:
            reasons.append((metric, f"{label} {delta:+.1f}{unit} ({a:.1f} -> {b:.1f})", a, b))
    if not reasons:
        return None
    return {
        "hub_id": new.hub_id,
        "name": new.name,
        "exposure": {"old": old.exposure, "new": new.exposure, "delta": round(new.exposure - old.exposure, 2)},
        "priority": {"old": old.priority, "new": new.priority, "delta": round(new.priority - old.priority, 2)},
        "exposure_band": {"old": old.exposure_band, "new": new.exposure_band},
        "priority_band": {"old": old.priority_band, "new": new.priority_band},
        "reasons": [r[1] for r in reasons],
        "_records": reasons,
    }


def _nws_key(alert: dict) -> str:
    return "|".join(str(alert.get(k)) for k in ("hub_id", "event", "headline", "expires"))


def _summary(changes: list[dict], nws: list[dict]) -> str:
    lines = [f"{c['name']}: {'; '.join(c['reasons'])}" for c in changes]
    lines += [f"NWS {a.get('severity')}: {a.get('event')} at {a.get('hub_id')}" for a in nws]
    text = "Weather risk alert\n" + "\n".join(lines)
    return text[:1900]  # Discord's content limit is 2000 characters


def _append_jsonl(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(payload) + "\n")


def check_alerts(
    store: Store,
    compute_rows: Callable[[], list[ScoreRow]],
    webhook_url: str | None,
    nws_fetch: Callable[[], list[dict]] | None,
    *,
    baseline_path: Path = BASELINE_PATH,
    log_path: Path = LOG_PATH,
    update_baseline: bool = False,
) -> dict[str, Any]:
    computed_at = _now()
    rows = compute_rows()
    store.record_scores(rows, computed_at)

    baseline = load_baseline(baseline_path)
    baseline_created = baseline is None
    changes: list[dict] = []
    if baseline is None:
        write_baseline(baseline_path, rows, computed_at)
    else:
        for new in sorted(rows, key=lambda r: r.hub_id):
            old = baseline.get(new.hub_id)
            change = compare(old, new) if old is not None else None
            if change is not None:
                for _, reason, a, b in change.pop("_records"):
                    store.record_alert(new.hub_id, a, b, reason)
                changes.append(change)
        if update_baseline:
            write_baseline(baseline_path, rows, computed_at)

    nws: list[dict] = []
    if nws_fetch is not None:
        active = [a for a in nws_fetch() if a.get("severity") in NWS_SEVERITIES]
        # NWS alerts carry no id here, so the key is what identifies one; report only alerts
        # that were not active in the previous run.
        previous = store.swap_nws_seen({_nws_key(a) for a in active})
        nws = [a for a in active if _nws_key(a) not in previous]

    delivered = None
    if changes or nws:
        text = _summary(changes, nws)
        payload = {"text": text, "content": text, "checked_at": computed_at, "changes": changes, "nws": nws}
        delivered = "jsonl"
        if webhook_url:
            try:
                httpx.post(webhook_url, json=payload, timeout=10).raise_for_status()
                delivered = "webhook"
            except (httpx.HTTPError, httpx.InvalidURL) as exc:
                payload["webhook_error"] = type(exc).__name__
        if delivered == "jsonl":
            _append_jsonl(log_path, payload)
    return {"changes": changes, "nws": nws, "delivered": delivered, "baseline_created": baseline_created}


# ---------- real scoring and data (Track A), imported lazily ----------


def _score_rows(snapshot: Any, window: tuple[str, str] | None = None) -> list[ScoreRow]:
    from app import scoring

    hubs = scoring.load_hubs()
    config = scoring.DEFAULT_CONFIG
    if window is not None:
        fields = type(config).model_fields
        if not all(f in fields for f in WINDOW_FIELDS):
            raise RuntimeError(f"ScoringConfig has no {WINDOW_FIELDS} fields; update app.alerts.WINDOW_FIELDS.")
        config = type(config).model_validate({**config.model_dump(), WINDOW_FIELDS[0]: window[0], WINDOW_FIELDS[1]: window[1]})
    return scoring.score_rows(scoring.score_all(hubs, snapshot, config), hubs)


@lru_cache(maxsize=1)
def _cached_snapshot_rows() -> tuple[ScoreRow, ...]:
    from app import scoring

    return tuple(_score_rows(scoring.load_snapshot()))


def snapshot_rows() -> list[ScoreRow]:
    """Scores over the committed snapshot (what /scores serves)."""
    return list(_cached_snapshot_rows())


def window_months() -> int:
    """Length of the scoring config's observed window in months (2015-01..2025-12 = 132)."""
    from app import scoring

    a = date.fromisoformat(scoring.DEFAULT_CONFIG.observed_start)
    b = date.fromisoformat(scoring.DEFAULT_CONFIG.observed_end)
    return (b.year * 12 + b.month) - (a.year * 12 + a.month) + 1


def rolling_window(today: date, months: int | None = None) -> tuple[str, str]:
    """The last `months` complete calendar months before today (default: as long as the scoring window).

    Same length as the baseline's window, so a fresh run differs from the baseline only by the months
    that rolled in and out, not by a different averaging period.
    """
    months = months or window_months()
    end = today.replace(day=1) - timedelta(days=1)
    first = end.year * 12 + end.month - months  # month index of the first month, 0-based
    start = date(first // 12, first % 12 + 1, 1)
    return start.isoformat(), end.isoformat()


def _window_series(series: dict[str, list], start: str, end: str) -> dict[str, list]:
    keep = [i for i, t in enumerate(series["time"]) if start <= t <= end]
    return {k: [v[i] for i in keep] for k, v in series.items()}


def fresh_rows(today: date | None = None) -> list[ScoreRow]:
    """Rescore on the rolling window (NRI stays from the snapshot).

    Days inside the committed snapshot are reused; only the days after the snapshot's end are
    fetched from Open-Meteo, which keeps the scheduled job well under its rate limit.
    """
    from app import data, scoring

    start, end = rolling_window(today or datetime.now(UTC).date())
    snapshot = scoring.load_snapshot()
    hubs = scoring.load_hubs()
    snap_end = snapshot.weather["end"]
    fetch_from = max(start, (date.fromisoformat(snap_end) + timedelta(days=1)).isoformat())
    merged = {}
    for hub in hubs:
        series = _window_series(snapshot.weather["hubs"][hub.id], start, end)
        if fetch_from <= end:
            new = data.fetch_weather(hub, fetch_from, end)
            series = {k: series[k] + list(new[k]) for k in series}
        merged[hub.id] = series
    weather = dict(snapshot.weather)
    weather.update(start=start, end=end, hubs=merged)
    if fetch_from <= end:
        weather["fetched_at"] = _now()
    return _score_rows(dataclasses.replace(snapshot, weather=weather), (start, end))


def fetch_severe_nws() -> list[dict]:
    """Active NWS alerts per hub; a failing hub is skipped so one outage does not stop the check."""
    from app import data, scoring

    out: list[dict] = []
    for hub in scoring.load_hubs():
        try:
            out += [{"hub_id": hub.id, **a} for a in data.fetch_nws_alerts(hub.lat, hub.lon)]
        except Exception as exc:  # upstream errors are reported, not fatal
            print(f"NWS fetch failed for {hub.id}: {type(exc).__name__}", file=sys.stderr)
    return out


def main(argv: list[str] | None = None) -> int:
    from dotenv import load_dotenv

    load_dotenv()
    parser = argparse.ArgumentParser(prog="python -m app.alerts", description="Check for score changes and NWS alerts.")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--snapshot", action="store_true", help="score the committed snapshot instead of fresh weather")
    group.add_argument("--demo-window", metavar="YYYY-YYYY", help="rescore the snapshot on these observed years")
    parser.add_argument("--update-baseline", action="store_true", help="replace the baseline with this run's scores")
    parser.add_argument("--no-nws", action="store_true", help="skip live NWS alerts")
    args = parser.parse_args(argv)

    if args.demo_window:
        first, last = args.demo_window.split("-")

        def compute() -> list[ScoreRow]:
            from app import scoring

            return _score_rows(scoring.load_snapshot(), (f"{first}-01-01", f"{last}-12-31"))
    elif args.snapshot:
        compute = snapshot_rows
    else:
        compute = fresh_rows

    result = check_alerts(
        Store(ROOT / "data" / "app.db"),
        compute,
        os.environ.get("ALERT_WEBHOOK_URL") or None,
        None if args.no_nws else fetch_severe_nws,
        update_baseline=args.update_baseline,
    )
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
