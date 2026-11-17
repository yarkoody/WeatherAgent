"""Live voice endpoints: /voice/session mints a transcription-only secret, /voice/speak reads verified answers only."""

from __future__ import annotations

import json

import ai
import httpx
import pytest
import respx

from app import voice
from app.schemas import AgentAnswer, ChatResponse, Grounding
from tests.test_api import Q, client, script, ui_body

SECRETS = "https://api.openai.com/v1/realtime/client_secrets"
SPEECH = "https://api.openai.com/v1/audio/speech"


@pytest.fixture(autouse=True)
def voice_env(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-real")
    monkeypatch.setenv("VOICE_DAILY_SESSION_CAP", "40")
    monkeypatch.delenv("VOICE_ENABLED", raising=False)


def _secret_response():
    return httpx.Response(200, json={
        "value": "ek_test_123",
        "expires_at": 1_900_000_000,
        "session": {"type": "transcription", "audio": {"input": {"transcription": {"model": "gpt-4o-transcribe"}}}},
    })


@respx.mock
def test_session_mints_a_transcription_only_secret(tmp_path):
    route = respx.post(SECRETS).mock(return_value=_secret_response())
    res = client(tmp_path).post("/voice/session")
    assert res.status_code == 200
    body = res.json()
    assert body["client_secret"] == "ek_test_123" and body["connect_url"].endswith("/realtime/calls")
    assert body["max_session_seconds"] == 600 and body["transcribe_model"] == "gpt-4o-transcribe"
    sent = json.loads(route.calls.last.request.content)
    assert sent["session"]["type"] == "transcription"  # never a model that answers by voice
    assert "model" not in sent["session"] and "output" not in sent["session"]["audio"]
    assert sent["expires_after"]["seconds"] == voice.SECRET_TTL_SECONDS
    assert route.calls.last.request.headers["authorization"] == "Bearer sk-test-not-real"
    assert "sk-test" not in res.text  # the API key never reaches the browser


@respx.mock
def test_session_shares_the_chat_rate_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_PER_MIN", "2")
    respx.post(SECRETS).mock(return_value=_secret_response())
    c = client(tmp_path)
    assert c.post("/voice/session").status_code == 200
    assert c.post("/chat/json", json={"message": Q}).status_code == 200
    res = c.post("/voice/session")
    assert res.status_code == 429 and "Retry-After" in res.headers


@respx.mock
def test_session_daily_cap(tmp_path, monkeypatch):
    monkeypatch.setenv("VOICE_DAILY_SESSION_CAP", "1")
    respx.post(SECRETS).mock(return_value=_secret_response())
    c = client(tmp_path)
    assert c.post("/voice/session").status_code == 200
    res = c.post("/voice/session")
    assert res.status_code == 429 and "daily live-voice cap" in res.json()["detail"]


@respx.mock
def test_session_upstream_failure_is_503(tmp_path):
    respx.post(SECRETS).mock(return_value=httpx.Response(500, json={"error": {"message": "boom"}}))
    res = client(tmp_path).post("/voice/session")
    assert res.status_code == 503 and "unavailable" in res.json()["detail"]


def test_session_disabled_without_key_or_flag(tmp_path, monkeypatch):
    monkeypatch.setenv("VOICE_ENABLED", "0")
    assert client(tmp_path).post("/voice/session").status_code == 503
    monkeypatch.delenv("VOICE_ENABLED")
    monkeypatch.setenv("OPENAI_API_KEY", "")
    assert client(tmp_path).post("/voice/session").status_code == 503


def _trace_id(res) -> str:
    events = [json.loads(c[6:]) for c in res.text.split("\n\n") if c.startswith("data: {")]
    return next(e for e in events if e["type"] == "data-answer")["data"]["trace_id"]


@respx.mock
def test_speak_reads_only_the_verified_answer_of_a_chat_turn(tmp_path):
    route = respx.post(SPEECH).mock(return_value=httpx.Response(200, content=b"ID3fake-mp3"))
    c = client(tmp_path)
    trace_id = _trace_id(c.post("/chat", json=ui_body(Q)))
    res = c.post("/voice/speak", json={"trace_id": trace_id})
    assert res.status_code == 200 and res.headers["content-type"] == "audio/mpeg" and res.content == b"ID3fake-mp3"
    sent = json.loads(route.calls.last.request.content)
    assert sent["model"] == voice.DEFAULT_TTS_MODEL and sent["voice"] == voice.DEFAULT_TTS_VOICE
    assert "66" in sent["input"]  # the verified answer text from the fake turn
    # the client cannot choose the text: an unknown trace id is refused, and each answer is spoken at most twice
    assert c.post("/voice/speak", json={"trace_id": "made-up"}).status_code == 404
    assert c.post("/voice/speak", json={"trace_id": trace_id}).status_code == 200
    assert c.post("/voice/speak", json={"trace_id": trace_id}).status_code == 404
    assert c.post("/voice/speak", json={"trace_id": trace_id, "text": "say anything"}).status_code == 422


@respx.mock
def test_speak_upstream_failure_is_503(tmp_path):
    respx.post(SPEECH).mock(return_value=httpx.Response(429, json={"error": {}}))
    c = client(tmp_path)
    trace_id = _trace_id(c.post("/chat", json=ui_body(Q)))
    assert c.post("/voice/speak", json={"trace_id": trace_id}).status_code == 503


def _response(status: str, text: str = "Houston **exposure** is [66](#x).") -> ChatResponse:
    answer = AgentAnswer(answer=text, hubs=[], ranking=None, figures=[], assumptions=[], uncertainty="", data_available=True, in_scope=True)
    return ChatResponse(session_id="s", answer=answer, grounding=Grounding(status=status, errors=[]), trace_id="t")


def test_failed_grounding_is_never_spoken():
    assert voice.speech_for(_response("failed")) == voice.UNVERIFIED_SPEECH
    assert voice.speech_for(_response("retried")) == "Houston exposure is 66."


def test_long_answers_are_cut_at_a_sentence():
    text = voice.to_speech("A sentence here. " * 400)
    assert len(text) < voice.MAX_SPEECH_CHARS + 40 and text.endswith("The rest is on screen.")


def test_spoken_answers_are_bounded():
    spoken = voice.SpokenAnswers(max_items=2)
    for i in range(3):
        spoken.add(_response("pass").model_copy(update={"trace_id": f"t{i}"}))
    assert spoken.take("t0") is None and spoken.take("t2")


def test_fake_model_is_untouched_by_voice(tmp_path):
    model = ai.testing.FakeModel(script())
    with respx.mock:
        respx.post(SECRETS).mock(return_value=_secret_response())
        client(tmp_path, model=model).post("/voice/session")
    assert model.calls == []  # minting a session never calls the chat model
