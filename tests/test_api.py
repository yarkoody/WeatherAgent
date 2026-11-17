import json

import ai
import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.schemas import ChatResponse, Hub, ScoreRow
from app.store import Store, Tracer
from tests import fakes
from tests.fakes import answer_json, call

Q = "How exposed is Houston?"


def script(q=Q):
    return [ai.user_message(q), ai.assistant_message(call("get_hub_risk", hub_id="houston")), ai.assistant_message(answer_json())]


def rows():
    def r(hub, priority, band):
        return ScoreRow(
            hub_id=hub, name=hub.title(), region="South", exposure=50.0, exposure_band="medium",
            priority=priority, priority_band=band, top_driver="flood",
        )

    return [r("dallas", 44.9, "medium"), r("miami", 63.5, "high"), r("houston", 58.2, "medium"), r("atlanta", 58.2, "medium")]


HUBS = [Hub(id="houston", name="Houston", city="Houston", state="TX", region="South", lat=29.76, lon=-95.37, county_fips="48201")]


@pytest.fixture(autouse=True)
def env(monkeypatch):
    for key, value in {"RATE_LIMIT_PER_MIN": "10", "DAILY_REQUEST_CAP": "300", "ALERT_TOKEN": "secret", "ALERT_WEBHOOK_URL": ""}.items():
        monkeypatch.setenv(key, value)


def client(tmp_path, model=None, **kw):
    app = create_app(
        model=model if model is not None else ai.testing.FakeModel(script()),
        store=Store(tmp_path / "app.db"),
        tracer=Tracer(tmp_path / "traces.jsonl"),
        registry=fakes,
        compute_rows=rows,
        list_hubs=lambda: HUBS,
        baseline_path=tmp_path / "score_baseline.json",
        alerts_log=tmp_path / "alerts.jsonl",
        **kw,
    )
    return TestClient(app)


def ui_body(text, chat_id="chat-1"):
    return {
        "id": chat_id,
        "messages": [
            {"id": "m0", "role": "user", "parts": [{"type": "text", "text": "earlier"}]},
            {"id": "m1", "role": "assistant", "parts": [{"type": "text", "text": "ignored"}]},
            {"id": "m2", "role": "user", "parts": [{"type": "text", "text": text}]},
        ],
        "trigger": "submit-message",
        "messageId": None,
    }


def test_chat_json_returns_chat_response(tmp_path):
    res = client(tmp_path).post("/chat/json", json={"session_id": None, "message": Q})
    assert res.status_code == 200
    body = ChatResponse.model_validate(res.json())
    assert body.grounding.status == "pass" and body.answer.figures[0].value == 66.0


def test_chat_stream_has_tool_parts_and_one_data_answer_and_no_text_deltas(tmp_path):
    res = client(tmp_path).post("/chat", json=ui_body(Q))
    assert res.status_code == 200
    assert res.headers["x-vercel-ai-ui-message-stream"] == "v1"
    assert res.headers["content-type"].startswith("text/event-stream")
    chunks = [c for c in res.text.split("\n\n") if c]
    assert chunks[-1] == "data: [DONE]"
    events = [json.loads(c[6:]) for c in chunks[:-1]]
    types = [e["type"] for e in events]
    assert "tool-input-available" in types and "tool-output-available" in types
    assert not any(t.startswith("text-") for t in types)
    assert types.count("data-answer") == 1 and types[-1] == "finish"
    answer = next(e for e in events if e["type"] == "data-answer")["data"]
    assert ChatResponse.model_validate(answer).session_id == "chat-1"


def test_chat_rejects_empty_and_oversized_message(tmp_path):
    model = ai.testing.FakeModel(script())
    c = client(tmp_path, model=model)
    for text in ("", "x" * 5000, "   "):
        for res in (c.post("/chat", json=ui_body(text)), c.post("/chat/json", json={"message": text})):
            assert res.status_code == 422, text
            assert isinstance(res.json()["detail"], str)
    assert c.post("/chat", json={"id": "x", "messages": []}).status_code == 422
    assert c.post("/chat", json={"messages": "nope"}).status_code == 422
    assert model.calls == []


def test_chat_message_at_2000_chars_is_accepted(tmp_path):
    text = "y" * 2000
    res = client(tmp_path, model=ai.testing.FakeModel(script(text))).post("/chat/json", json={"message": text})
    assert res.status_code == 200


def test_scores_sorted_by_priority(tmp_path):
    res = client(tmp_path).get("/scores")
    assert res.status_code == 200
    assert [r["hub_id"] for r in res.json()] == ["miami", "atlanta", "houston", "dallas"]  # tie broken by hub_id


def test_hubs(tmp_path):
    assert client(tmp_path).get("/hubs").json()[0]["id"] == "houston"


def test_alerts_check_requires_token(tmp_path, monkeypatch):
    c = client(tmp_path, nws_fetch=lambda: [])
    assert c.post("/alerts/check").status_code == 401
    assert c.post("/alerts/check", headers={"X-Alert-Token": "wrong"}).status_code == 401
    res = c.post("/alerts/check", headers={"X-Alert-Token": "secret"})
    assert res.status_code == 200
    assert res.json()["changes"] == [] and res.json()["nws"] == []
    monkeypatch.setenv("ALERT_TOKEN", "")
    c = client(tmp_path, nws_fetch=lambda: [])
    assert c.post("/alerts/check", headers={"X-Alert-Token": ""}).status_code == 401


def test_rate_limit_returns_429(tmp_path, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MIN", "2")
    scripts = [script(f"q{i}") for i in range(3)]
    c = client(tmp_path, model=ai.testing.FakeModel(*scripts))
    ip_a = {"X-Forwarded-For": "1.1.1.1, 10.0.0.1"}
    assert c.post("/chat/json", json={"message": "q0"}, headers=ip_a).status_code == 200
    assert c.post("/chat", json=ui_body("q1"), headers=ip_a).status_code == 200
    blocked = c.post("/chat/json", json={"message": "q2"}, headers=ip_a)
    assert blocked.status_code == 429 and isinstance(blocked.json()["detail"], str)
    assert c.post("/chat/json", json={"message": "q2"}, headers={"X-Forwarded-For": "2.2.2.2"}).status_code == 200


def test_daily_cap_returns_429(tmp_path, monkeypatch):
    monkeypatch.setenv("DAILY_REQUEST_CAP", "1")
    c = client(tmp_path, model=ai.testing.FakeModel(script("q0")))
    assert c.post("/chat/json", json={"message": "q0"}, headers={"X-Forwarded-For": "1.1.1.1"}).status_code == 200
    res = c.post("/chat/json", json={"message": "q1"}, headers={"X-Forwarded-For": "3.3.3.3"})
    assert res.status_code == 429 and "daily" in res.json()["detail"].lower()


def test_model_unavailable_returns_503(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "")
    app = create_app(store=Store(tmp_path / "app.db"), tracer=Tracer(tmp_path / "t.jsonl"), registry=fakes)
    res = TestClient(app).post("/chat/json", json={"message": Q})
    assert res.status_code == 503 and isinstance(res.json()["detail"], str)
    res = TestClient(app).post("/chat", json=ui_body(Q))
    assert res.status_code == 503


def test_model_failure_on_chat_json_returns_503(tmp_path):
    c = client(tmp_path, model=ai.testing.FakeModel(script("something else")))
    res = c.post("/chat/json", json={"message": Q})
    assert res.status_code == 503 and isinstance(res.json()["detail"], str)


def test_health_and_import_without_api_key(tmp_path, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    import app.api

    assert TestClient(app.api.app).get("/health").json() == {"status": "ok"}
    assert client(tmp_path).get("/health").json() == {"status": "ok"}
