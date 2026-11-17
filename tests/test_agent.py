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


async def test_stream_turn_model_error_emits_error_part(store, tracer):
    model = ai.testing.FakeModel([ai.user_message("something else"), ai.assistant_message("x")])
    chunks = [c async for c in stream_turn(Q, "s1", model=model, store=store, tracer=tracer, registry=fakes)]
    types = [json.loads(c[6:])["type"] for c in chunks if c.startswith("data: {")]
    assert "error" in types and "data-answer" not in types
    assert chunks[-1] == "data: [DONE]\n\n"
