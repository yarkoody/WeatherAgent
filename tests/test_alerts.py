import json

import httpx
import respx

from app.alerts import check_alerts
from app.schemas import ScoreRow
from app.store import Store

URL = "https://hooks.example.test/alerts"


def row(hub="dallas", exposure=50.0, priority=40.0, exposure_band="medium", priority_band="medium",
        bad_year_days=None, hurricane_pct=0.0):
    return ScoreRow(
        hub_id=hub, name=hub.title(), region="South", exposure=exposure, exposure_band=exposure_band,
        priority=priority, priority_band=priority_band, top_driver="severe_storm",
        exposure_days_per_year=exposure / 4, bad_year_days=exposure / 2 if bad_year_days is None else bad_year_days,
        hurricane_10yr_probability_pct=hurricane_pct,
    )


def run(tmp_path, rows, webhook_url=None, nws=None, db="app.db", **kw):
    return check_alerts(
        Store(tmp_path / db),
        lambda: rows,
        webhook_url,
        (lambda: nws) if nws is not None else None,
        baseline_path=tmp_path / "score_baseline.json",
        log_path=tmp_path / "alerts.jsonl",
        state_path=tmp_path / "alert_state.json",
        **kw,
    )


def test_first_run_records_baseline_without_alert(tmp_path):
    result = run(tmp_path, [row()])
    assert result["changes"] == [] and result["baseline_created"] is True
    baseline = json.loads((tmp_path / "score_baseline.json").read_text())
    assert baseline["rows"][0]["hub_id"] == "dallas"
    assert not (tmp_path / "alerts.jsonl").exists()
    assert Store(tmp_path / "app.db").latest_scores()["dallas"].priority == 40.0


def test_change_of_5_points_alerts(tmp_path):
    run(tmp_path, [row(), row("houston")])
    result = run(tmp_path, [row(priority=45.0), row("houston", exposure=54.9)])
    assert [c["hub_id"] for c in result["changes"]] == ["dallas"]
    change = result["changes"][0]
    assert change["priority"] == {"old": 40.0, "new": 45.0, "delta": 5.0}
    assert change["reasons"] == ["priority +5.0 (40.0 -> 45.0)"]
    alerts = Store(tmp_path / "app.db").alerts()
    assert alerts[0]["hub_id"] == "dallas" and alerts[0]["old"] == 40.0 and alerts[0]["new"] == 45.0


def test_band_change_alerts(tmp_path):
    run(tmp_path, [row(exposure=58.0)])
    result = run(tmp_path, [row(exposure=62.0, exposure_band="high")])  # 2 points past the 60 cut-off
    assert result["changes"][0]["reasons"] == ["exposure band medium -> high (58.0 -> 62.0)"]


def test_no_change_no_alert(tmp_path):
    run(tmp_path, [row()])
    result = run(tmp_path, [row(priority=44.9, exposure=46.0)])
    assert result["changes"] == [] and result["delivered"] is None
    assert not (tmp_path / "alerts.jsonl").exists()
    assert Store(tmp_path / "app.db").alerts() == []


@respx.mock
def test_webhook_posted_with_payload(tmp_path):
    route = respx.post(URL).mock(return_value=httpx.Response(204))
    run(tmp_path, [row()])
    nws = [
        {"hub_id": "dallas", "event": "Tornado Warning", "severity": "Extreme", "headline": "Tornado", "expires": None},
        {"hub_id": "dallas", "event": "Wind Advisory", "severity": "Moderate", "headline": "Wind", "expires": None},
    ]
    result = run(tmp_path, [row(priority=50.0)], webhook_url=URL, nws=nws)
    assert route.called and result["delivered"] == "webhook"
    payload = json.loads(route.calls[0].request.content)
    assert payload["changes"][0]["hub_id"] == "dallas"
    assert [a["event"] for a in payload["nws"]] == ["Tornado Warning"]  # only Severe or Extreme
    assert "Dallas" in payload["text"] and payload["content"] == payload["text"]
    assert not (tmp_path / "alerts.jsonl").exists()


@respx.mock
def test_webhook_failure_falls_back_to_jsonl(tmp_path):
    respx.post(URL).mock(return_value=httpx.Response(500))
    run(tmp_path, [row()])
    result = run(tmp_path, [row(priority=50.0)], webhook_url=URL)
    assert result["delivered"] == "jsonl"
    assert (tmp_path / "alerts.jsonl").exists()


def test_no_webhook_writes_jsonl(tmp_path):
    run(tmp_path, [row()])
    result = run(tmp_path, [row(priority=33.0, priority_band="low")])  # 2 points below the 35 cut-off
    assert result["delivered"] == "jsonl"
    lines = [json.loads(line) for line in (tmp_path / "alerts.jsonl").read_text().splitlines()]
    assert lines[0]["changes"][0]["hub_id"] == "dallas"
    assert len(lines[0]["changes"][0]["reasons"]) == 2  # -7.0 points and band medium -> low


def test_rolling_window_matches_the_scoring_window_length():
    # Scoring uses 2015-2025 (132 months); the scheduled job rescores on the last 132 complete months,
    # so a fresh run differs from the baseline only by the months that rolled in and out.
    from datetime import date

    from app.alerts import rolling_window, window_months

    assert window_months() == 132
    assert rolling_window(date(2026, 11, 17)) == ("2015-11-01", "2026-10-31")
    assert rolling_window(date(2026, 1, 1)) == ("2015-01-01", "2025-12-31")
    assert rolling_window(date(2026, 11, 17), months=36) == ("2023-11-01", "2026-10-31")


def test_fresh_rows_fetch_only_days_after_the_snapshot(monkeypatch):
    from datetime import date, timedelta

    from app import alerts, data

    calls = []

    def fake_fetch(hub, start, end):
        calls.append((hub.id, start, end))
        d, last, out = date.fromisoformat(start), date.fromisoformat(end), {"time": []}
        for var in data.DAILY_VARS:
            out[var] = []
        while d <= last:
            out["time"].append(d.isoformat())
            for var in data.DAILY_VARS:
                out[var].append(0.0)
            d += timedelta(days=1)
        return out

    monkeypatch.setattr(data, "fetch_weather", fake_fetch)
    rows = alerts.fresh_rows(date(2026, 2, 10))  # window 2015-02-01 .. 2026-01-31
    assert len(rows) == 15
    assert len(calls) == 15
    assert {(start, end) for _, start, end in calls} == {("2026-01-01", "2026-01-31")}


def test_fresh_rows_on_snapshot_window_fetches_nothing(monkeypatch):
    from datetime import date

    from app import alerts, data

    def no_fetch(*args, **kwargs):
        raise AssertionError("nothing to fetch: the window is inside the snapshot")

    monkeypatch.setattr(data, "fetch_weather", no_fetch)
    fresh = {r.hub_id: r for r in alerts.fresh_rows(date(2026, 1, 15))}  # window 2015-01-01 .. 2025-12-31
    base = {r.hub_id: r for r in alerts.snapshot_rows()}
    assert fresh == base


def test_invalid_webhook_url_falls_back_to_jsonl(tmp_path, monkeypatch):
    def invalid(*args, **kwargs):
        raise httpx.InvalidURL("Invalid URL")

    monkeypatch.setattr(httpx, "post", invalid)
    run(tmp_path, [row()])
    result = run(tmp_path, [row(priority=50.0)], webhook_url="http://bad url")
    assert result["delivered"] == "jsonl"


def test_only_new_nws_alerts_are_reported(tmp_path):
    tornado = {"hub_id": "dallas", "event": "Tornado Warning", "severity": "Extreme", "headline": "T", "expires": "2099-01-01T00:00:00Z"}
    flood = {"hub_id": "houston", "event": "Flash Flood Warning", "severity": "Severe", "headline": "F", "expires": None}
    assert [a["event"] for a in run(tmp_path, [row()], nws=[tornado])["nws"]] == ["Tornado Warning"]
    second = run(tmp_path, [row()], nws=[tornado])
    assert second["nws"] == [] and second["delivered"] is None
    assert [a["event"] for a in run(tmp_path, [row()], nws=[tornado, flood])["nws"]] == ["Flash Flood Warning"]


# ---------- alert once per new change (state file) ----------


def test_same_deviation_two_runs_in_a_row_alerts_once(tmp_path):
    run(tmp_path, [row()])  # baseline: priority 40
    assert [c["hub_id"] for c in run(tmp_path, [row(priority=50.0)])["changes"]] == ["dallas"]
    again = run(tmp_path, [row(priority=50.0)])
    assert again["changes"] == [] and again["delivered"] is None
    state = json.loads((tmp_path / "alert_state.json").read_text())
    assert state["hubs"]["dallas"]["priority"] == 50.0


def test_further_change_alerts_again(tmp_path):
    run(tmp_path, [row()])
    run(tmp_path, [row(priority=50.0)])
    result = run(tmp_path, [row(priority=56.0)])
    assert result["changes"][0]["reasons"] == ["priority +6.0 (50.0 -> 56.0)"]


def test_small_drift_adds_up_against_the_last_alerted_state(tmp_path):
    run(tmp_path, [row()])
    assert run(tmp_path, [row(priority=43.0)])["changes"] == []
    assert run(tmp_path, [row(priority=46.0)])["changes"][0]["reasons"] == ["priority +6.0 (40.0 -> 46.0)"]


def test_nws_alert_seen_once_alerts_once_even_with_a_fresh_database(tmp_path):
    tornado = {"hub_id": "dallas", "event": "Tornado Warning", "severity": "Extreme", "headline": "T", "expires": "2099-01-01T00:00:00Z"}
    assert len(run(tmp_path, [row()], nws=[tornado], db="run1.db")["nws"]) == 1
    run(tmp_path, [row()], nws=[], db="run2.db")  # the alert briefly missing from the feed
    assert run(tmp_path, [row()], nws=[tornado], db="run3.db")["nws"] == []  # a new runner: fresh SQLite


def test_expired_nws_keys_are_forgotten(tmp_path):
    old = {"hub_id": "dallas", "event": "Wind Warning", "severity": "Severe", "headline": "W", "expires": "2000-01-01T00:00:00Z"}
    run(tmp_path, [row()], nws=[old])
    assert json.loads((tmp_path / "alert_state.json").read_text())["nws_seen"] == {}


@respx.mock
def test_failed_webhook_does_not_advance_the_state(tmp_path):
    route = respx.post(URL).mock(side_effect=[httpx.Response(500), httpx.Response(204)])
    run(tmp_path, [row()])
    assert run(tmp_path, [row(priority=50.0)], webhook_url=URL)["delivered"] == "jsonl"
    retry = run(tmp_path, [row(priority=50.0)], webhook_url=URL)
    assert retry["delivered"] == "webhook" and retry["changes"][0]["hub_id"] == "dallas"
    assert route.call_count == 2


def test_update_baseline_resets_the_alert_state(tmp_path):
    run(tmp_path, [row()])
    run(tmp_path, [row(priority=50.0)], update_baseline=True)
    assert json.loads((tmp_path / "alert_state.json").read_text())["hubs"] == {}
    assert run(tmp_path, [row(priority=50.0)])["changes"] == []


# ---------- hysteresis and the extra triggers ----------


def test_band_flapping_near_a_cut_off_does_not_alert():
    from app.alerts import compare

    # 59.7 medium -> 60.1 high crosses 60 by only 0.1: no alert (needs 62.0)
    assert compare(row(exposure=59.7, exposure_band="medium"), row(exposure=60.1, exposure_band="high")) is None
    # and back down: 60.1 high -> 59.7 medium is not 2 points below 60 either
    assert compare(row(exposure=60.1, exposure_band="high"), row(exposure=59.7, exposure_band="medium")) is None


def test_band_change_two_points_past_the_cut_off_alerts():
    from app.alerts import compare

    up = compare(row(exposure=59.7, exposure_band="medium"), row(exposure=62.0, exposure_band="high"))
    assert up and any("band medium -> high" in r for r in up["reasons"])
    down = compare(row(exposure=60.1, exposure_band="high"), row(exposure=58.0, exposure_band="medium"))
    assert down and any("band high -> medium" in r for r in down["reasons"])
    low = compare(row(priority=36.0, priority_band="medium"), row(priority=33.0, priority_band="low"))
    assert low and any("priority band medium -> low" in r for r in low["reasons"])


def test_bad_year_change_of_3_days_alerts():
    from app.alerts import compare

    assert compare(row(bad_year_days=20.0), row(bad_year_days=22.9)) is None
    out = compare(row(bad_year_days=20.0), row(bad_year_days=23.0))
    assert out and any("bad-year days +3.0" in r for r in out["reasons"])


def test_hurricane_probability_change_of_10_points_alerts():
    from app.alerts import compare

    assert compare(row(hurricane_pct=60.0), row(hurricane_pct=69.9)) is None
    out = compare(row(hurricane_pct=60.0), row(hurricane_pct=70.0))
    assert out and any("hurricane 10-year probability +10.0" in r for r in out["reasons"])


def test_new_scoring_version_resets_the_baseline_instead_of_alerting(tmp_path):
    from app import scoring

    run(tmp_path, [row(exposure=50.0)])
    stored = json.loads((tmp_path / "score_baseline.json").read_text())
    assert stored["scoring_version"] == scoring.SCORING_VERSION
    stored["scoring_version"] = "v2-old-formula"
    (tmp_path / "score_baseline.json").write_text(json.dumps(stored))
    result = run(tmp_path, [row(exposure=80.0, exposure_band="high")])  # would alert under the same version
    assert result["changes"] == [] and result["baseline_created"] is True
    assert json.loads((tmp_path / "score_baseline.json").read_text())["scoring_version"] == scoring.SCORING_VERSION
    again = run(tmp_path, [row(exposure=50.0)])  # now compared against the new baseline
    assert again["changes"] and again["baseline_created"] is False
