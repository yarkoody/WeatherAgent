"""Discord alert subscriptions, the Discord test message, and the alert fan-out. No real Discord call: httpx.post is replaced."""

import httpx
import pytest

from app import send
from app.alerts import fan_out
from app.store import Store
from tests.test_alerts import row, run
from tests.test_api import client, env  # noqa: F401  (env: the autouse fixture that sets ALERT_TOKEN and the limits)

GOOD = "https://discord.com/api/webhooks/123456789012345678/abcDEF_-123"
GOOD_OLD_HOST = "https://discordapp.com/api/webhooks/1/x"


@pytest.mark.parametrize("url", [GOOD, GOOD_OLD_HOST])
def test_discord_webhook_urls_are_accepted(url):
    assert send.validate_discord_webhook(url) == url


@pytest.mark.parametrize(
    "url",
    [
        "http://discord.com/api/webhooks/1/x",  # not https
        "https://evil.com/api/webhooks/1/x",
        "https://discord.com.evil.com/api/webhooks/1/x",
        "https://evildiscord.com/api/webhooks/1/x",
        "https://ptb.discord.com/api/webhooks/1/x",  # subdomains are not on the list
        "https://162.159.135.232/api/webhooks/1/x",  # IP literal
        "https://[::1]/api/webhooks/1/x",
        "https://discord.com:8443/api/webhooks/1/x",  # port
        "https://discord.com:443/api/webhooks/1/x",
        "https://user@discord.com/api/webhooks/1/x",  # user info
        "https://discord.com@evil.com/api/webhooks/1/x",
        "https://discord.com/api/channels/1/messages",  # other path
        "https://discord.com/api/webhooks/1",
        "https://discord.com/api/webhooks/abc/x",
        "https://discord.com/api/webhooks/1/x/../../channels",
        "https://discord.com/api/webhooks/1/x?wait=true",  # query
        "https://discord.com/api/webhooks/1/x#frag",
        "https://DISCORD.com/api/webhooks/1/x",
        " https://discord.com/api/webhooks/1/x",
        "https://discord.com\\@evil.com/api/webhooks/1/x",
        "https://discord.com/api/webhooks/1/" + "x" * 300,
        "",
        "javascript:alert(1)",
    ],
)
def test_other_urls_are_rejected(url):
    with pytest.raises(ValueError):
        send.validate_discord_webhook(url)


class FakeHttp:
    """Stands in for httpx.post and records each call. `status` may map a URL to its status."""

    def __init__(self, status=204, exc=None):
        self.status, self.exc, self.calls = status, exc, []

    def __call__(self, url, **kw):
        self.calls.append((url, kw))
        if self.exc:
            raise self.exc
        status = self.status.get(url, 204) if isinstance(self.status, dict) else self.status
        return httpx.Response(status, request=httpx.Request("POST", url))


@pytest.fixture
def http(monkeypatch):
    fake = FakeHttp()
    monkeypatch.setattr(send.httpx, "post", fake)
    return fake


# ---------- the Discord test message ----------


def test_test_message_is_fixed_text_without_pings_or_redirects(tmp_path, http):
    res = client(tmp_path).post("/send/discord", json={"webhook_url": GOOD, "content": "ignored @everyone"})
    assert res.status_code == 200 and res.json() == {"status": "sent"}
    (url, kw), = http.calls
    assert url == GOOD
    assert kw["timeout"] == 5.0 and kw["follow_redirects"] is False
    assert kw["json"]["allowed_mentions"] == {"parse": []}
    assert kw["json"]["content"].startswith("Test message from Hub Weather Risk")
    assert "@everyone" not in kw["json"]["content"]


def test_test_message_rejects_other_urls_before_any_request(tmp_path, http):
    res = client(tmp_path).post("/send/discord", json={"webhook_url": "https://evil.com/api/webhooks/1/x"})
    assert res.status_code == 422
    assert http.calls == []
    assert "evil.com" not in res.text


@pytest.mark.parametrize(
    ("status", "exc", "expected"),
    [
        (404, None, 404),
        (401, None, 404),
        (429, None, 429),
        (301, None, 502),  # a redirect is an error, never followed
        (500, None, 502),
        (204, httpx.ConnectTimeout("slow"), 504),
        (204, httpx.ConnectError("down"), 502),
    ],
)
def test_discord_errors_map_to_clear_statuses_without_the_url(tmp_path, monkeypatch, caplog, status, exc, expected):
    monkeypatch.setattr(send.httpx, "post", FakeHttp(status, exc))
    res = client(tmp_path).post("/send/discord", json={"webhook_url": GOOD})
    assert res.status_code == expected
    assert "abcDEF" not in res.text and "abcDEF" not in caplog.text


def test_test_message_is_rate_limited(tmp_path, http, monkeypatch):
    monkeypatch.setenv("SUBSCRIBE_RATE_LIMIT_PER_MIN", "2")
    c = client(tmp_path)
    assert [c.post("/send/discord", json={"webhook_url": GOOD}).status_code for _ in range(3)] == [200, 200, 429]


# ---------- Discord subscriptions ----------


def test_subscribe_posts_a_confirmation_then_stores(tmp_path, http):
    c = client(tmp_path)
    res = c.post("/alerts/subscribe", json={"webhook_url": GOOD})
    assert res.json() == {"status": "subscribed"}
    assert "score-change alerts" in http.calls[0][1]["json"]["content"]
    assert Store(tmp_path / "app.db").subscriptions() == [GOOD]
    assert c.post("/alerts/subscribe", json={"webhook_url": GOOD}).json() == {"status": "already_subscribed"}
    assert len(http.calls) == 1  # no second confirmation
    assert c.post("/alerts/unsubscribe", json={"webhook_url": GOOD}).json() == {"status": "unsubscribed"}
    assert c.post("/alerts/unsubscribe", json={"webhook_url": GOOD}).json() == {"status": "not_subscribed"}
    assert Store(tmp_path / "app.db").subscriptions() == []


def test_subscribe_with_a_dead_webhook_stores_nothing(tmp_path, monkeypatch):
    monkeypatch.setattr(send.httpx, "post", FakeHttp(404))
    res = client(tmp_path).post("/alerts/subscribe", json={"webhook_url": GOOD})
    assert res.status_code == 404
    assert Store(tmp_path / "app.db").subscriptions() == []


def test_subscribe_rejects_bad_bodies_without_any_request(tmp_path, http):
    c = client(tmp_path)
    assert c.post("/alerts/subscribe", json={"webhook_url": "http://169.254.169.254/latest"}).status_code == 422
    assert c.post("/alerts/unsubscribe", json={"webhook_url": "https://evil.com/x"}).status_code == 422
    assert c.post("/alerts/subscribe", json={}).status_code == 422
    assert http.calls == []


def test_discord_subscriptions_are_capped(tmp_path, http, monkeypatch):
    from app import api

    monkeypatch.setattr(api, "MAX_SUBSCRIPTIONS", 2)
    monkeypatch.setenv("SUBSCRIBE_RATE_LIMIT_PER_MIN", "100")
    c = client(tmp_path)
    for i in range(2):
        assert c.post("/alerts/subscribe", json={"webhook_url": f"https://discord.com/api/webhooks/{i}/t"}).status_code == 200
    assert c.post("/alerts/subscribe", json={"webhook_url": "https://discord.com/api/webhooks/9/t"}).status_code == 409


def test_subscribe_is_rate_limited(tmp_path, http, monkeypatch):
    monkeypatch.setenv("SUBSCRIBE_RATE_LIMIT_PER_MIN", "2")
    c = client(tmp_path)
    codes = [c.post("/alerts/subscribe", json={"webhook_url": f"https://discord.com/api/webhooks/{i}/t"}).status_code for i in range(3)]
    assert codes == [200, 200, 429]


def test_store_cap_holds_inside_the_transaction(tmp_path):
    s = Store(tmp_path / "s.db")
    assert s.add_subscription("a", cap=1) == "added"
    assert s.add_subscription("a", cap=1) == "exists"
    assert s.add_subscription("b", cap=1) == "full"


# ---------- fan-out ----------


def test_alert_goes_to_every_subscriber_and_dead_webhooks_are_removed(tmp_path, monkeypatch):
    dead = "https://discord.com/api/webhooks/2/dead"
    fake = FakeHttp({dead: 404})
    monkeypatch.setattr(send.httpx, "post", fake)
    store = Store(tmp_path / "app.db")
    for url in (GOOD, dead, GOOD_OLD_HOST):
        store.add_subscription(url, cap=50)
    run(tmp_path, [row(priority=40.0)])  # first run writes the baseline
    result = run(tmp_path, [row(priority=47.0)])
    assert result["changes"] and result["subscribers"] == {"sent": 2, "failed": 1, "removed": 1}
    assert [u for u, _ in fake.calls] == [GOOD, dead, GOOD_OLD_HOST]
    assert all("priority +7.0" in kw["json"]["content"] for _, kw in fake.calls)
    assert store.subscriptions() == [GOOD, GOOD_OLD_HOST]


def test_no_change_posts_nothing_to_subscribers(tmp_path, http):
    Store(tmp_path / "app.db").add_subscription(GOOD, cap=50)
    run(tmp_path, [row()])
    assert run(tmp_path, [row()])["subscribers"]["sent"] == 0
    assert http.calls == []


def test_failed_main_webhook_holds_the_subscriber_alert_for_the_retry(tmp_path, monkeypatch):
    """The state does not advance when the main webhook fails, so subscribers get the alert once, on the retry."""
    posted = []

    def fake(url, **kw):
        posted.append(url)
        ok = url != "https://hooks.example/main" or posted.count(url) > 1
        return httpx.Response(204 if ok else 500, request=httpx.Request("POST", url))

    monkeypatch.setattr("app.alerts.httpx.post", fake)  # the same module object as send.httpx
    Store(tmp_path / "app.db").add_subscription(GOOD, cap=50)
    run(tmp_path, [row(priority=40.0)])
    first = run(tmp_path, [row(priority=47.0)], webhook_url="https://hooks.example/main")
    assert first["subscribers"]["sent"] == 0 and GOOD not in posted
    second = run(tmp_path, [row(priority=47.0)], webhook_url="https://hooks.example/main")
    assert second["subscribers"]["sent"] == 1 and posted.count(GOOD) == 1


def test_fan_out_with_no_subscribers_is_a_no_op(tmp_path):
    assert fan_out(Store(tmp_path / "x.db"), "hi") == {"sent": 0, "failed": 0, "removed": 0}


def test_alerts_check_reaches_subscribers(tmp_path, http):
    c = client(tmp_path, nws_fetch=lambda: [{"severity": "Extreme", "event": "Tornado Warning", "hub_id": "dallas", "headline": "h", "expires": None}])
    Store(tmp_path / "app.db").add_subscription(GOOD, cap=50)
    res = c.post("/alerts/check", headers={"X-Alert-Token": "secret"})
    assert res.json()["subscribers"] == {"sent": 1, "failed": 0, "removed": 0}
    assert "Tornado Warning" in http.calls[-1][1]["json"]["content"]


def test_alerts_check_demo_window_is_validated(tmp_path):
    c = client(tmp_path, nws_fetch=lambda: [])
    assert c.post("/alerts/check?demo_window=2017", headers={"X-Alert-Token": "secret"}).status_code == 422
    assert c.post("/alerts/check?demo_window=2018-2015", headers={"X-Alert-Token": "secret"}).status_code == 422
