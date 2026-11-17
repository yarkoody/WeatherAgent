import json

import ai
import pytest

from app import grounding
from app.agent import PARSE_ERROR, retry_message, run_turn, stream_turn
from app.schemas import AgentAnswer
from app.store import Store, Tracer
from tests import fakes
from tests.fakes import answer_json, call, hub_risk, tool_msg

Q = "How exposed is Houston?"


@pytest.fixture
def store(tmp_path):
    return Store(tmp_path / "app.db")


@pytest.fixture
def tracer(tmp_path):
    return Tracer(tmp_path / "traces.jsonl")


def traces(tracer):
    return [json.loads(line) for line in tracer.path.read_text().splitlines()]


async def turn(model, store, tracer, message=Q, session_id=None, **kw):
    return await run_turn(message, session_id, model=model, store=store, tracer=tracer, registry=fakes, **kw)


async def test_tool_call_then_answer(store, tracer):
    tc = call("get_hub_risk", hub_id="houston")
    model = ai.testing.FakeModel([ai.user_message(Q), ai.assistant_message(tc), ai.assistant_message(answer_json())])
    res = await turn(model, store, tracer)
    assert res.grounding.status == "pass" and res.grounding.errors == []
    assert res.answer.figures[0].value == 66.0
    assert res.session_id and res.trace_id
    assert not model.unused
    # the model saw the tool result
    tool_msgs = [m for m in model.calls[-1] if m.role == "tool"]
    assert tool_msgs[0].tool_results[0].result["exposure"] == 66.0


async def test_step_limit_forces_final_answer(store, tracer):
    script = [ai.user_message(Q)]
    for _ in range(3):
        script.append(ai.assistant_message(call("get_hub_risk", hub_id="houston")))
    script.append(ai.assistant_message(answer_json()))
    model = ai.testing.FakeModel(script)
    res = await turn(model, store, tracer, max_steps=3)
    assert res.grounding.status == "pass"
    llm_calls = [t for t in traces(tracer) if t["kind"] == "llm_call"]
    assert [c["tools"] for c in llm_calls] == [2, 2, 2, 0]
    assert not model.unused


async def test_step_limit_with_no_valid_answer_returns_fallback(store, tracer):
    tc = call("get_hub_risk", hub_id="houston")
    model = ai.testing.FakeModel(
        [
            ai.user_message(Q),
            ai.assistant_message(tc),
            ai.assistant_message("not json"),
            ai.user_message(retry_message([PARSE_ERROR])),
            ai.assistant_message("still not json"),
        ]
    )
    res = await turn(model, store, tracer, max_steps=1)
    assert res.grounding.status == "failed"
    assert res.answer.data_available is False and res.answer.figures == []
    unparsed = [t for t in traces(tracer) if t["kind"] == "unparsed_reply"]
    assert [u["text"] for u in unparsed] == ["not json", "still not json"]
    assert unparsed[0]["tool_calls"] == 0 and unparsed[0]["purpose"] == "forced_final"
    assert not model.unused


async def test_grounding_failure_retries_once_then_passes(store, tracer):
    tc = call("get_hub_risk", hub_id="houston")
    bad = answer_json("Houston exposure is 43%.", [("houston", "exposure", 43.0)])
    errors = grounding.check(AgentAnswer.model_validate_json(bad), [hub_risk("houston")], None)
    model = ai.testing.FakeModel(
        [
            ai.user_message(Q),
            ai.assistant_message(tc),
            ai.assistant_message(bad),
            ai.user_message(retry_message(errors)),
            ai.assistant_message(answer_json()),
        ]
    )
    res = await turn(model, store, tracer)
    assert res.grounding.status == "retried"
    assert res.answer.figures[0].value == 66.0
    event = next(t for t in traces(tracer) if t["kind"] == "grounding")
    assert event["first_errors"] == errors and event["errors"] == []
    assert not model.unused
    # the retry instruction is not stored in history
    stored = store.get_messages(res.session_id)
    assert all("grounding check" not in json.dumps(m) for m in stored)
    assert [m["role"] for m in stored] == ["user", "assistant", "tool", "assistant"]


async def test_grounding_failure_twice_marks_failed_and_drops_bad_figures(store, tracer):
    tc = call("get_hub_risk", hub_id="houston")
    bad = answer_json("Exposure 66 and 43.", [("houston", "exposure", 66.0), ("houston", "made up", 43.0)])
    errors = grounding.check(AgentAnswer.model_validate_json(bad), [hub_risk("houston")], None)
    model = ai.testing.FakeModel(
        [
            ai.user_message(Q),
            ai.assistant_message(tc),
            ai.assistant_message(bad),
            ai.user_message(retry_message(errors)),
            ai.assistant_message(bad),
        ]
    )
    res = await turn(model, store, tracer)
    assert res.grounding.status == "failed"
    assert any("43" in e for e in res.grounding.errors)
    assert [f.value for f in res.answer.figures] == [66.0]


async def test_follow_up_uses_stored_history(store, tracer):
    tc = call("get_hub_risk", hub_id="houston")
    first = answer_json()
    q2 = "And its priority?"
    second = answer_json("Houston priority is 58.2.", [("houston", "priority", 58.2)])
    model = ai.testing.FakeModel(
        [
            ai.user_message(Q),
            ai.assistant_message(tc),
            ai.assistant_message(first),
            ai.user_message(q2),
            ai.assistant_message(second),
        ]
    )
    r1 = await turn(model, store, tracer)
    # second turn calls no tool: 58.2 is grounded by the stored tool result of turn 1
    r2 = await turn(model, store, tracer, message=q2, session_id=r1.session_id)
    assert r2.session_id == r1.session_id
    assert r2.grounding.status == "pass"
    assert not model.unused
    assert len(store.get_messages(r1.session_id)) == 6


async def test_tool_error_is_passed_back_to_model(store, tracer):
    tc = call("get_hub_risk", hub_id="gotham")
    error = hub_risk("gotham")
    no_data = answer_json("I don't have data for Gotham.", [], hubs=[], data_available=False)
    model = ai.testing.FakeModel(
        [ai.user_message("Gotham risk?"), ai.assistant_message(tc), tool_msg(tc, error), ai.assistant_message(no_data)]
    )
    res = await turn(model, store, tracer, message="Gotham risk?")
    assert error["retryable"] is False and "Valid hub ids" in error["hint"]
    assert res.answer.data_available is False
    assert res.grounding.status == "pass"
    assert not model.unused


async def test_unknown_tool_name_returns_error_to_model(store, tracer):
    tc = call("delete_everything")
    model = ai.testing.FakeModel(
        [ai.user_message(Q), ai.assistant_message(tc), ai.assistant_message(answer_json("No data.", [], data_available=False))]
    )
    res = await turn(model, store, tracer)
    tool_results = [p for m in model.calls[-1] if m.role == "tool" for p in m.tool_results]
    assert "Unknown tool" in tool_results[0].result["error"]
    assert res.answer.data_available is False


async def test_trace_events_written(store, tracer):
    tc = call("get_hub_risk", hub_id="houston")
    model = ai.testing.FakeModel([ai.user_message(Q), ai.assistant_message(tc), ai.assistant_message(answer_json())])
    res = await turn(model, store, tracer)
    events = traces(tracer)
    assert {e["trace_id"] for e in events} == {res.trace_id}
    kinds = [e["kind"] for e in events]
    for kind in ("user_message", "llm_call", "tool_call", "grounding", "final_answer", "turn_end"):
        assert kind in kinds
    tool_event = next(e for e in events if e["kind"] == "tool_call")
    assert tool_event["name"] == "get_hub_risk" and tool_event["args"] == {"hub_id": "houston"}
    assert tool_event["error"] is None and tool_event["result_bytes"] > 0


async def test_stream_turn_emits_tool_parts_then_one_answer_and_no_text(store, tracer):
    tc = call("get_hub_risk", hub_id="houston")
    model = ai.testing.FakeModel([ai.user_message(Q), ai.assistant_message(tc), ai.assistant_message(answer_json())])
    chunks = [c async for c in stream_turn(Q, "s1", model=model, store=store, tracer=tracer, registry=fakes)]
    assert chunks[-1] == "data: [DONE]\n\n"
    events = [json.loads(c[6:]) for c in chunks[:-1]]
    types = [e["type"] for e in events]
    assert not any(t.startswith("text-") for t in types)
    assert types.count("data-answer") == 1 and types[-1] == "finish"
    assert types.index("tool-input-available") < types.index("tool-output-available") < types.index("data-answer")
    data = next(e for e in events if e["type"] == "data-answer")["data"]
    assert data["session_id"] == "s1" and data["grounding"]["status"] == "pass"
    tool_input = next(e for e in events if e["type"] == "tool-input-available")
    assert tool_input["toolName"] == "get_hub_risk" and tool_input["input"] == {"hub_id": "houston"}
    assert len(store.get_messages("s1")) == 4


async def test_stream_turn_model_error_emits_fallback_answer(store, tracer):
    model = ai.testing.FakeModel([ai.user_message("something else"), ai.assistant_message("x")])
    chunks = [c async for c in stream_turn(Q, "s1", model=model, store=store, tracer=tracer, registry=fakes)]
    assert chunks[-1] == "data: [DONE]\n\n"
    events = [json.loads(c[6:]) for c in chunks[:-1]]
    types = [e["type"] for e in events]
    assert types[0] == "start" and types[-1] == "finish"
    assert types.count("data-answer") == 1 and "error" not in types
    data = next(e for e in events if e["type"] == "data-answer")["data"]
    assert data["session_id"] == "s1" and data["trace_id"]
    assert data["grounding"]["status"] == "failed" and data["grounding"]["errors"]
    assert data["answer"]["data_available"] is False and data["answer"]["figures"] == []
    assert store.get_messages("s1") == []  # a failed turn is not stored


async def test_reasoning_is_not_streamed(store, tracer):
    reply = ai.assistant_message(ai.thinking("Let me think about Houston."), answer_json())
    model = ai.testing.FakeModel([ai.user_message(Q), ai.assistant_message(call("get_hub_risk", hub_id="houston")), reply])
    chunks = [c async for c in stream_turn(Q, "s1", model=model, store=store, tracer=tracer, registry=fakes)]
    types = [json.loads(c[6:])["type"] for c in chunks[:-1]]
    assert not any(t.startswith(("reasoning", "text-")) for t in types)
    assert types.count("data-answer") == 1


async def test_failed_path_drops_ranking(store, tracer):
    tc = call("get_hub_risk", hub_id="houston")
    bad = answer_json("Exposure 43.", [("houston", "made up", 43.0)], ranking=["houston"])
    errors = grounding.check(AgentAnswer.model_validate_json(bad), [hub_risk("houston")], None)
    model = ai.testing.FakeModel(
        [ai.user_message(Q), ai.assistant_message(tc), ai.assistant_message(bad), ai.user_message(retry_message(errors)), ai.assistant_message(bad)]
    )
    res = await turn(model, store, tracer)
    assert res.grounding.status == "failed" and res.answer.ranking is None and res.answer.figures == []


async def test_answer_cut_off_by_length_fails_without_retry(store, tracer, monkeypatch):
    from ai.types import events as events_module

    original = events_module._replay_message_events

    async def replay(message):
        async for event in original(message):
            if isinstance(event, ai.events.StreamEnd) and message.text.startswith("CUT"):
                event = event.model_copy(update={"finish_reason": "length"})
            yield event

    monkeypatch.setattr(events_module, "_replay_message_events", replay)
    model = ai.testing.FakeModel([ai.user_message(Q), ai.assistant_message('CUT {"answer": "Houston is')])
    res = await turn(model, store, tracer)
    assert res.grounding.status == "failed" and "cut off" in res.grounding.errors[0]
    assert res.answer.data_available is False
    llm_calls = [t for t in traces(tracer) if t["kind"] == "llm_call"]
    assert len(llm_calls) == 1 and llm_calls[0]["finish_reason"] == "length"


async def test_parallel_tool_calls_count_as_one_round(store, tracer):
    a, b = call("get_hub_risk", hub_id="houston"), call("get_hub_risk", hub_id="dallas")
    reply = answer_json("Houston 66, Dallas 41.7.", [("houston", "exposure", 66.0), ("dallas", "exposure", 41.7)], hubs=["houston", "dallas"])
    model = ai.testing.FakeModel([ai.user_message(Q), ai.assistant_message(a, b), ai.assistant_message(reply)])
    res = await turn(model, store, tracer)
    assert res.grounding.status == "pass"
    events = traces(tracer)
    assert sorted(e["args"]["hub_id"] for e in events if e["kind"] == "tool_call") == ["dallas", "houston"]
    assert next(e for e in events if e["kind"] == "grounding")["tool_rounds"] == 1
    assert [e["tools"] for e in events if e["kind"] == "llm_call"] == [2, 2]  # no forced final call needed


async def test_tool_that_raises_becomes_tool_error(store, tracer):
    from types import SimpleNamespace

    def broken(name, arguments_json):
        raise RuntimeError("database down")

    registry = SimpleNamespace(TOOL_FUNCTIONS=fakes.TOOL_FUNCTIONS, ARG_MODELS=fakes.ARG_MODELS, run_tool=broken)
    tc = call("get_hub_risk", hub_id="houston")
    error = {"error": "Tool get_hub_risk failed.", "retryable": True, "hint": "RuntimeError"}
    model = ai.testing.FakeModel(
        [ai.user_message(Q), ai.assistant_message(tc), tool_msg(tc, error), ai.assistant_message(answer_json("No data.", [], data_available=False))]
    )
    res = await run_turn(Q, None, model=model, store=store, tracer=tracer, registry=registry)
    assert res.answer.data_available is False and not model.unused
    assert next(e for e in traces(tracer) if e["kind"] == "tool_call")["error"] == "Tool get_hub_risk failed."


async def test_sdk_error_results_are_not_citable(store, tracer):
    bad_args = ai.messages.ToolCallPart(tool_call_id="call_bad", tool_name="get_hub_risk", tool_args='{"hub_id": 77')
    reply = answer_json("Thirteen.", [(None, "from an error", 13.0)], hubs=[])
    model = ai.testing.FakeModel(
        [ai.user_message(Q), ai.assistant_message(bad_args), ai.assistant_message(reply), ai.user_message(retry_message(
            ["Figure 'from an error' has value 13, which no tool returned. Use only numbers exactly as tools returned them."]
        )), ai.assistant_message(reply)]
    )
    res = await turn(model, store, tracer)
    assert res.grounding.status == "failed"


def test_reasoning_effort_defaults_to_low_and_env_overrides(monkeypatch):
    from app.agent import build_params

    monkeypatch.delenv("OPENAI_REASONING_EFFORT", raising=False)
    assert build_params().reasoning.effort == "low"
    assert build_params().output.max_tokens == 2000
    monkeypatch.setenv("OPENAI_REASONING_EFFORT", "medium")
    assert build_params().reasoning.effort == "medium"
    monkeypatch.setenv("OPENAI_REASONING_EFFORT", "default")  # non-reasoning models: send no reasoning setting
    assert build_params().reasoning is ai.DEFAULT


def test_cost_estimate_uses_price_table():
    from app.agent import _cost

    assert _cost("gpt-6.1-sol", 1_000_000, 100_000) == 3.0
    assert _cost("unknown-model", 1000, 1000) is None
