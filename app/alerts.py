"""Score-change alerts (bonus).

Recompute scores, compare with the committed baseline `data/snapshot/score_baseline.json`,
and report every hub whose exposure or priority moved by 5 points or more, or whose band
changed. Also reports active Severe or Extreme NWS alerts at the hubs. Delivery: a JSON
POST to ALERT_WEBHOOK_URL, or a line in logs/alerts.jsonl when no URL is set (or the
webhook fails). The same text then goes to every Discord webhook subscribed in the store
(POST /alerts/subscribe); a subscriber that fails never blocks the others or the state.

    python -m app.alerts                       # fresh weather, rolling window as long as the scoring window
    python -m app.alerts --snapshot            # committed snapshot as is
    python -m app.alerts --demo-window 2015-2017   # snapshot rescored on another window (live demo)
    python -m app.alerts --update-baseline     # also replace the baseline with this run's scores

The baseline is a committed file, not SQLite, because Render's disk resets on deploy and the
scheduled job runs in GitHub Actions. It is the reviewed reference and only changes on the first
run or with --update-baseline.

Alert once per new change: logs/alert_state.json keeps the scores each hub was last alerted at and
the NWS alerts already sent. A hub is compared with that state (or the baseline if it was never
alerted), so a persisting deviation alerts once and further drift alerts again. The scheduled job
keeps the file between runs with actions/cache.
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
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
# Last alerted state per hub and the NWS alerts already sent. Gitignored; the scheduled job keeps it
# between runs with actions/cache, so a persisting deviation alerts once, not every day.
STATE_PATH = ROOT / "logs" / "alert_state.json"
NWS_SEEN_TTL = timedelta(days=7)  # how long an NWS alert without an expiry time stays "seen"
POINTS_THRESHOLD = 5.0
BAND_HYSTERESIS = 2.0  # a band change alerts only when the new score is this far past the cut-off
BAD_YEAR_DAYS_THRESHOLD = 3.0
HURRICANE_PCT_THRESHOLD = 10.0
NWS_SEVERITIES = {"Severe", "Extreme"}
# Scoring config fields that hold the observed weather window (Track A's ScoringConfig).
WINDOW_FIELDS = ("observed_start", "observed_end")


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def formula_version() -> str:
    """SCORING_VERSION plus a hash of the scoring config: scores compare only within one formula.

    The hash catches a changed config value even when SCORING_VERSION was not bumped. It is always
    taken from DEFAULT_CONFIG, so the scheduled job's rolling observed window does not change it.
    """
    from app import scoring

    config = json.dumps(scoring.DEFAULT_CONFIG.model_dump(mode="json"), sort_keys=True)
    return f"{scoring.SCORING_VERSION}-{hashlib.sha256(config.encode()).hexdigest()[:12]}"


_scoring_version = formula_version


def load_baseline(path: Path) -> dict[str, ScoreRow] | None:
    """The baseline rows (any version; check baseline_version), or None when there is no baseline."""
    if not path.exists():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    return {r["hub_id"]: ScoreRow.model_validate(r) for r in data["rows"]}


def baseline_version(path: Path) -> str | None:
    try:
        return json.loads(path.read_text(encoding="utf-8")).get("scoring_version")
    except (OSError, ValueError):
        return None


def write_baseline(path: Path, rows: list[ScoreRow], computed_at: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"computed_at": computed_at, "scoring_version": _scoring_version(),
               "rows": [r.model_dump(mode="json") for r in sorted(rows, key=lambda r: r.hub_id)]}
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


def load_state(path: Path) -> dict[str, Any]:
    """{"scoring_version", "hubs": {hub_id: last alerted ScoreRow}, "nws_seen": {key: forget_after_iso}}.

    A missing file gives an empty state with "exists": False ("exists" is never written).
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"exists": False, "scoring_version": None, "hubs": {}, "nws_seen": {}}
    return {
        "exists": True,
        "scoring_version": data.get("scoring_version"),
        "hubs": dict(data.get("hubs") or {}),
        "nws_seen": dict(data.get("nws_seen") or {}),
    }


def write_state(path: Path, state: dict[str, Any], updated_at: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    body = {k: v for k, v in state.items() if k != "exists"}
    tmp.write_text(json.dumps({"updated_at": updated_at, **body}, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def _forget_after(alert: dict, now: datetime) -> str:
    expires = alert.get("expires")
    if isinstance(expires, str):
        try:
            return datetime.fromisoformat(expires.replace("Z", "+00:00")).astimezone(UTC).isoformat(timespec="seconds")
        except ValueError:
            pass
    return (now + NWS_SEEN_TTL).isoformat(timespec="seconds")


def _nws_key(alert: dict) -> str:
    return "|".join(str(alert.get(k)) for k in ("hub_id", "event", "headline", "expires"))


def reset_message(old: str, new: str) -> str:
    return f"Scoring method changed ({old} -> {new}); alert baseline reset, no score alerts this run."


def _summary(changes: list[dict], nws: list[dict], reset: dict[str, str] | None = None) -> str:
    lines = [f"{c['name']}: {'; '.join(c['reasons'])}" for c in changes]
    lines += [f"NWS {a.get('severity')}: {a.get('event')} at {a.get('hub_id')}" for a in nws]
    if reset is not None:
        text = "\n".join([reset_message(reset["old"], reset["new"]), *lines])
    else:
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
    state_path: Path = STATE_PATH,
    update_baseline: bool = False,
) -> dict[str, Any]:
    """Alert once per new change.

    Each hub is compared with the state it was last alerted at (or the baseline if it never was).
    An alert moves that hub's state to the new scores, so the same deviation does not alert again,
    while further drift does. NWS alerts are sent once and remembered until they expire. If a
    configured webhook fails, the state is not advanced, so the next run tries again.

    Scores compare only when the reference comes from the current formula (formula_version, stored
    in the state and the baseline). Otherwise one short "scoring method changed" message replaces
    the score alerts and the state is reset to the current scores; NWS alerts work as usual. The
    committed baseline is replaced only on purpose (update_baseline).
    """
    current = formula_version()
    now = datetime.now(UTC)
    computed_at = now.isoformat(timespec="seconds")
    from app.data import UpstreamError

    scores_skipped: str | None = None
    rows: list[ScoreRow] | None
    try:
        rows = compute_rows()
    except UpstreamError as exc:
        # The weather source is down (Open-Meteo timed out on the GitHub runner): skip the score check this run
        # and keep the score state, so the next run compares against the same reference. NWS alerts still go out.
        rows = None
        scores_skipped = f"{type(exc).__name__}: {exc}"
        print(f"Score check skipped: {scores_skipped}", file=sys.stderr)
    else:
        store.record_scores(rows, computed_at)
    state = load_state(state_path)
    alerted_hubs: dict[str, dict] = {}

    baseline = load_baseline(baseline_path)
    baseline_created = baseline is None and rows is not None
    changes: list[dict] = []
    reset: dict[str, str] | None = None
    if rows is not None and baseline is not None and not update_baseline:
        # The reference is the state for hubs alerted before and the baseline for the rest: both must
        # come from the current formula, or a method change would show up as score changes.
        old_baseline = baseline_version(baseline_path)
        if state["exists"] and state["scoring_version"] != current:
            reset = {"old": state["scoring_version"] or "unknown", "new": current}
        elif old_baseline != current and any(r.hub_id not in state["hubs"] for r in rows):
            reset = {"old": old_baseline or "unknown", "new": current}
    if rows is None:
        pass  # no scores this run: nothing to compare, the baseline stays as it is
    elif baseline is None or update_baseline:
        write_baseline(baseline_path, rows, computed_at)
    elif reset is not None:
        alerted_hubs = {r.hub_id: r.model_dump(mode="json") for r in rows}
    else:
        for new in sorted(rows, key=lambda r: r.hub_id):
            last = state["hubs"].get(new.hub_id)
            old = ScoreRow.model_validate(last) if last else baseline.get(new.hub_id)
            change = compare(old, new) if old is not None else None
            if change is not None:
                for _, reason, a, b in change.pop("_records"):
                    store.record_alert(new.hub_id, a, b, reason)
                changes.append(change)
                alerted_hubs[new.hub_id] = new.model_dump(mode="json")

    # Seen NWS keys, minus the ones past their forget time.
    seen = {k: t for k, t in state["nws_seen"].items() if t > computed_at}
    nws: list[dict] = []
    new_seen: dict[str, str] = {}
    if nws_fetch is not None:
        active = [a for a in nws_fetch() if a.get("severity") in NWS_SEVERITIES]
        # NWS alerts carry no id here, so the key (hub, event, headline, expires) identifies one.
        for alert in active:
            key = _nws_key(alert)
            if key not in seen and key not in new_seen:
                nws.append(alert)
                new_seen[key] = _forget_after(alert, now)
        new_seen = {k: t for k, t in new_seen.items() if t > computed_at}

    delivered = None
    if changes or nws or reset:
        text = _summary(changes, nws, reset)
        payload = {"text": text, "content": text, "checked_at": computed_at, "changes": changes, "nws": nws}
        if reset is not None:
            payload["formula_reset"] = reset
        delivered = "jsonl"
        if webhook_url:
            try:
                httpx.post(webhook_url, json=payload, timeout=10).raise_for_status()
                delivered = "webhook"
            except (httpx.HTTPError, httpx.InvalidURL) as exc:
                payload["webhook_error"] = type(exc).__name__
        if delivered == "jsonl":
            _append_jsonl(log_path, payload)

    sent = delivered == "webhook" or (delivered == "jsonl" and not webhook_url)
    # Subscribers get an alert only once it counts as sent: a failed main webhook keeps the state, the next run
    # sends the same alert again, and subscribers then get it once instead of twice.
    subscribers = fan_out(store, text) if sent and delivered else dict(NO_FAN_OUT)
    if rows is None:
        pass  # keep the score state and its formula version for the next run
    elif update_baseline:
        state["hubs"] = {}  # the new baseline is the reference again
        state["scoring_version"] = current
    elif reset is not None:
        if sent:  # a failed webhook keeps the old state, so the reset message is sent again next run
            state["hubs"] = alerted_hubs
            state["scoring_version"] = current
    else:
        if sent:
            state["hubs"].update(alerted_hubs)
        state["scoring_version"] = current
    state["nws_seen"] = {**seen, **new_seen} if sent else seen
    write_state(state_path, state, computed_at)
    return {
        "changes": changes,
        "nws": nws,
        "delivered": delivered,
        "baseline_created": baseline_created,
        "formula_reset": reset,
        "subscribers": subscribers,
        "scores_skipped": scores_skipped,
    }


NO_FAN_OUT = {"sent": 0, "failed": 0, "removed": 0}


def fan_out(store: Store, text: str) -> dict[str, int]:
    """Post the alert text to every subscribed Discord webhook. A webhook Discord no longer knows is removed."""
    from app import send

    counts = dict(NO_FAN_OUT)
    for url in store.subscriptions():
        try:
            send.post_discord(url, text)
            counts["sent"] += 1
        except (send.SendError, ValueError) as exc:
            counts["failed"] += 1
            if isinstance(exc, ValueError) or exc.status == 404:
                store.remove_subscription(url)
                counts["removed"] += 1
    return counts


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
