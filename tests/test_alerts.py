import json

import httpx
import respx

from app.alerts import check_alerts
from app.schemas import ScoreRow
from app.store import Store

URL = "https://hooks.example.test/alerts"


def row(hub="dallas", exposure=50.0, priority=40.0, exposure_band="medium", priority_band="medium"):
    return ScoreRow(
        hub_id=hub, name=hub.title(), region="South", exposure=exposure, exposure_band=exposure_band,
        priority=priority, priority_band=priority_band, top_driver="severe_storm",
    )


def run(tmp_path, rows, webhook_url=None, nws=None):
    return check_alerts(
        Store(tmp_path / "app.db"),
        lambda: rows,
        webhook_url,
        (lambda: nws) if nws is not None else None,
        baseline_path=tmp_path / "score_baseline.json",
        log_path=tmp_path / "alerts.jsonl",
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
    result = run(tmp_path, [row(exposure=60.0, exposure_band="high")])
    assert result["changes"][0]["reasons"] == ["exposure band medium -> high (58.0 -> 60.0)"]


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
    result = run(tmp_path, [row(priority=34.0, priority_band="low")])
    assert result["delivered"] == "jsonl"
    lines = [json.loads(line) for line in (tmp_path / "alerts.jsonl").read_text().splitlines()]
    assert lines[0]["changes"][0]["hub_id"] == "dallas"
    assert len(lines[0]["changes"][0]["reasons"]) == 2  # -6.0 points and band medium -> low


def test_rolling_window_is_last_36_complete_months():
    from datetime import date

    from app.alerts import rolling_window

    assert rolling_window(date(2026, 11, 17)) == ("2023-11-01", "2026-10-31")
    assert rolling_window(date(2026, 1, 1)) == ("2023-01-01", "2025-12-31")


def test_invalid_webhook_url_falls_back_to_jsonl(tmp_path, monkeypatch):
    def invalid(*args, **kwargs):
        raise httpx.InvalidURL("Invalid URL")

    monkeypatch.setattr(httpx, "post", invalid)
    run(tmp_path, [row()])
    result = run(tmp_path, [row(priority=50.0)], webhook_url="http://bad url")
    assert result["delivered"] == "jsonl"


def test_only_new_nws_alerts_are_reported(tmp_path):
    tornado = {"hub_id": "dallas", "event": "Tornado Warning", "severity": "Extreme", "headline": "T", "expires": "2026-11-17T20:00:00Z"}
    flood = {"hub_id": "houston", "event": "Flash Flood Warning", "severity": "Severe", "headline": "F", "expires": None}
    assert [a["event"] for a in run(tmp_path, [row()], nws=[tornado])["nws"]] == ["Tornado Warning"]
    second = run(tmp_path, [row()], nws=[tornado])
    assert second["nws"] == [] and second["delivered"] is None
    assert [a["event"] for a in run(tmp_path, [row()], nws=[tornado, flood])["nws"]] == ["Flash Flood Warning"]
    run(tmp_path, [row()], nws=[])
    assert [a["event"] for a in run(tmp_path, [row()], nws=[tornado])["nws"]] == ["Tornado Warning"]  # expired, then new again
