"""The agent: a bounded tool-calling loop on the Vercel AI SDK for Python.

One turn:
1. Up to `max_steps` tool rounds. Each model call offers the tools and asks for an
   `AgentAnswer` JSON (strict json_schema), so a reply without tool calls is the answer.
2. If the step limit is reached, one more call with `tools=[]` forces the answer.
3. Code checks the answer against every tool result of the session (grounding).
   On failure the model gets the errors once (the retry message is not stored).
   If it still fails, the answer is returned flagged "failed" with ungrounded figures dropped.

Answer text is never streamed: `stream_turn` forwards tool progress only, then one
`data-answer` part with the verified `ChatResponse`.
"""

from __future__ import annotations

import importlib
import inspect
import json
import os
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from types import ModuleType
from typing import Any

import ai
from ai.ui.ai_sdk.outbound_stream import format_done_sse, format_sse
from ai.ui.ai_sdk.ui_events import (
    UIDataEvent,
    UIErrorEvent,
    UIFinishEvent,
    UIToolInputAvailableEvent,
    UIToolOutputAvailableEvent,
    UIToolOutputErrorEvent,
)
from openai.lib._pydantic import to_strict_json_schema

from app import grounding
from app.schemas import AgentAnswer, ChatResponse, Grounding, ToolError
from app.store import Store, Tracer

SYSTEM_PROMPT = (Path(__file__).parent / "prompts" / "system.md").read_text(encoding="utf-8")
MAX_STEPS = 6
MAX_OUTPUT_TOKENS = 2000
# Low effort is enough: the code does the scoring, the model picks tools and writes the JSON answer.
# OPENAI_REASONING_EFFORT overrides it; "default" sends no reasoning setting (for non-reasoning models).
DEFAULT_REASONING_EFFORT = "low"


def build_params() -> ai.InferenceRequestParams:
    effort = os.environ.get("OPENAI_REASONING_EFFORT", "").strip() or DEFAULT_REASONING_EFFORT
    reasoning = ai.DEFAULT if effort == "default" else ai.ReasoningParams(effort=effort)
    return ai.InferenceRequestParams(output=ai.OutputParams(max_tokens=MAX_OUTPUT_TOKENS), reasoning=reasoning)


PARSE_ERROR = "The reply was not valid JSON for the AgentAnswer schema."
GROUNDING_RETRY_TEMPLATE = (
    "Your previous answer failed the grounding check:\n{errors}\n\n"
    "Reply again with the complete AgentAnswer JSON. Use only numbers exactly as the tools returned them, "
    "put every number from the answer text in figures, and copy any ranking in the order the tools returned it."
)
STREAM_ERROR_TEXT = "The model or an upstream service is unavailable. Please try again."

FALLBACK_ANSWER = AgentAnswer(
    answer="I could not produce a verified answer to this question. Please rephrase it or try again.",
    hubs=[],
    ranking=None,
    figures=[],
    assumptions=[],
    uncertainty="The model did not return a valid answer, so nothing here is backed by data.",
    data_available=False,
    in_scope=True,
)

# USD per 1M tokens (input, output) for the trace cost estimate; an unknown model gets cost_usd = null.
# gpt-6.1-sol: $2 / $10 standard rate, from third-party pages citing OpenAI's pricing (2026-11-17);
# verify at developers.openai.com/api/docs/pricing. Cached input is cheaper, so this is an upper bound.
PRICES_PER_MTOK: dict[str, tuple[float, float]] = {"gpt-6.1-sol": (2.0, 10.0)}

_TEXT_EVENTS = (ai.events.TextStart, ai.events.TextDelta, ai.events.TextEnd)


def retry_message(errors: list[str]) -> str:
    return GROUNDING_RETRY_TEMPLATE.format(errors="\n".join(f"- {e}" for e in errors))


def get_model() -> ai.Model:
    """The production model, from OPENAI_MODEL. Tests pass ai.testing.FakeModel instead."""
    from dotenv import load_dotenv

    load_dotenv()
    model_id = os.environ.get("OPENAI_MODEL", "").strip()
    if not model_id:
        raise RuntimeError("OPENAI_MODEL is not set. Put the model id in .env (see .env.example).")
    return ai.get_model(f"openai:{model_id}")


def _registry(registry: Any | None) -> Any:
    # Imported lazily so this module (and the API) loads without the scoring data.
    return registry if registry is not None else importlib.import_module("app.tools")


def _is_tool_error(result: Any) -> bool:
    return isinstance(result, dict) and set(result) == set(ToolError.model_fields)


def build_tools(registry: ModuleType | Any, tracer: Tracer, trace_id: str) -> list[ai.AgentTool]:
    """One ai.AgentTool per registry function, with a strict schema from its args model.

    No SDK validator: run_tool validates and returns a ToolError the model can read.
    """
    tools = []
    for fn in registry.TOOL_FUNCTIONS:
        name = fn.__name__
        spec = ai.tools.ToolSpec(
            description=inspect.getdoc(fn) or name,
            params=to_strict_json_schema(registry.ARG_MODELS[name]),
        )
        tools.append(ai.AgentTool(tool=ai.Tool(kind="function", name=name, spec=spec), fn=_runner(registry, name, tracer, trace_id)))
    return tools


def _runner(registry: Any, name: str, tracer: Tracer, trace_id: str):
    async def run(**kwargs: Any) -> Any:
        start = time.perf_counter()
        try:
            result = registry.run_tool(name, json.dumps(kwargs))
            if inspect.isawaitable(result):
                result = await result
        except Exception as exc:  # run_tool never raises by contract; this is the last line of defence
            result = ToolError(error=f"Tool {name} failed.", retryable=True, hint=type(exc).__name__).model_dump()
        tracer.event(
            trace_id,
            "tool_call",
            name=name,
            args=kwargs,
            latency_ms=round((time.perf_counter() - start) * 1000, 1),
            result_bytes=len(json.dumps(result, default=str)),
            error=result["error"] if _is_tool_error(result) else None,
        )
        return result

    return run


def _parse(message: ai.messages.Message | None) -> AgentAnswer | None:
    if message is None:
        return None
    try:
        return message.get_output(AgentAnswer)
    except ValueError:  # includes pydantic.ValidationError and "message has tool calls"
        return None


class WeatherAgent(ai.Agent):
    """Custom loop: bounded tool rounds, forced final answer, grounding check with one retry.

    Results are kept on the instance (answer, grounding, turn_messages); one instance per turn.
    """

    def __init__(
        self,
        *,
        tools: list[ai.AgentTool],
        tracer: Tracer,
        trace_id: str,
        max_steps: int = MAX_STEPS,
        prior_tool_results: list[Any] | None = None,
    ) -> None:
        super().__init__(tools=tools)
        self.tracer = tracer
        self.trace_id = trace_id
        self.max_steps = max_steps
        self.prior_tool_results = list(prior_tool_results or [])
        self.turn_tool_results: list[Any] = []
        self.turn_messages: list[ai.messages.Message] = []
        self.answer: AgentAnswer | None = None
        self.grounding: Grounding | None = None
        self.input_tokens = 0
        self.output_tokens = 0

    def _check(self, answer: AgentAnswer | None) -> list[str]:
        if answer is None:
            return [PARSE_ERROR]
        return grounding.check(answer, self.prior_tool_results + self.turn_tool_results, None)

    async def _call(self, model: ai.Model, messages: list[ai.messages.Message], tools: list[ai.Tool], purpose: str, out: list):
        """One model call; runs requested tools; appends (assistant message, tool message | None) to out."""
        start = time.perf_counter()
        async with (
            ai.stream(model, messages, tools=tools, output_type=AgentAnswer, params=build_params()) as stream,
            ai.ToolRunner() as runner,
            ai.util.merge(stream, runner.events()) as events,
        ):
            async for event in events:
                yield event
                if isinstance(event, ai.events.ToolEnd) and tools:
                    part = event.tool_call
                    if self._tool_resolver.get(part.tool_name) is None:
                        error = ToolError(
                            error=f"Unknown tool '{part.tool_name}'.",
                            retryable=False,
                            hint=f"Available tools: {', '.join(t.name for t in tools)}.",
                        ).model_dump()
                        self.tracer.event(self.trace_id, "tool_call", name=part.tool_name, args=part.tool_args, error=error["error"])
                        runner.add_result(ai.tool_result(tool_call_id=part.tool_call_id, tool_name=part.tool_name, result=error))
                    else:
                        runner.schedule(self.resolve(part))
                elif isinstance(event, ai.events.ToolCallResult):
                    self.turn_tool_results.extend(p.result for p in event.results)
        usage = stream.message.usage
        if usage is not None:
            self.input_tokens += usage.input_tokens
            self.output_tokens += usage.output_tokens
        self.tracer.event(
            self.trace_id,
            "llm_call",
            purpose=purpose,
            model=model.id,
            tools=len(tools),
            latency_ms=round((time.perf_counter() - start) * 1000, 1),
            input_tokens=usage.input_tokens if usage else None,
            output_tokens=usage.output_tokens if usage else None,
        )
        out.append((stream.message, runner.get_tool_message()))

    async def loop(self, context: ai.Context):
        rounds = 0
        while True:
            tools = context.tools if rounds < self.max_steps else []
            out: list = []
            async for event in self._call(context.model, context.messages, tools, "step" if tools else "forced_final", out):
                yield event
            message, tool_message = out[0]
            if tools and tool_message is not None:
                context.add(message)
                context.add(tool_message)
                self.turn_messages += [message, tool_message]
                rounds += 1
                continue
            break

        answer = _parse(message)
        errors = self._check(answer)
        first_errors = list(errors)
        status = "pass"
        if errors:
            # Rebuild the rejected reply as plain text so the retry never carries dangling tool calls.
            retry_context = [
                *context.messages,
                ai.assistant_message(message.text or "(no answer)"),
                ai.user_message(retry_message(errors)),
            ]
            out = []
            async for event in self._call(context.model, retry_context, [], "grounding_retry", out):
                yield event
            retry_answer = _parse(out[0][0])
            retry_errors = self._check(retry_answer)
            if not retry_errors:
                answer, errors, status = retry_answer, [], "retried"
            else:
                status = "failed"
                if retry_answer is not None:
                    answer, errors = retry_answer, retry_errors
                if answer is None:
                    answer = FALLBACK_ANSWER
                else:
                    answer = grounding.drop_ungrounded_figures(answer, self.prior_tool_results + self.turn_tool_results)

        self.answer = answer
        self.grounding = Grounding(status=status, errors=errors)
        # History keeps the verified answer, not the raw reply or the retry instruction.
        self.turn_messages.append(ai.assistant_message(answer.model_dump_json()))
        self.tracer.event(self.trace_id, "grounding", status=status, errors=errors, first_errors=first_errors, tool_rounds=rounds)
        self.tracer.event(self.trace_id, "final_answer", answer=answer.model_dump(mode="json"))


def _cost(model_id: str, input_tokens: int, output_tokens: int) -> float | None:
    price = PRICES_PER_MTOK.get(model_id)
    if price is None:
        return None
    return round((input_tokens * price[0] + output_tokens * price[1]) / 1_000_000, 6)


async def _turn_events(
    message: str,
    session_id: str | None,
    *,
    model: ai.Model,
    store: Store,
    tracer: Tracer,
    max_steps: int,
    registry: Any | None,
    holder: dict[str, Any],
) -> AsyncIterator[Any]:
    session_id = session_id or uuid.uuid4().hex
    trace_id = uuid.uuid4().hex
    holder["trace_id"] = trace_id
    started = time.perf_counter()
    tracer.event(trace_id, "user_message", session_id=session_id, text=message)
    try:
        history = [ai.messages.Message.model_validate(m) for m in store.get_messages(session_id)]
        prior = [p.result for m in history if m.role == "tool" for p in m.tool_results]
        agent = WeatherAgent(
            tools=build_tools(_registry(registry), tracer, trace_id),
            tracer=tracer,
            trace_id=trace_id,
            max_steps=max_steps,
            prior_tool_results=prior,
        )
        user = ai.user_message(message)
        async with agent.run(model, [ai.system_message(SYSTEM_PROMPT), *history, user]) as stream:
            async for event in stream:
                yield event
    except BaseException as exc:
        tracer.event(trace_id, "error", error=f"{type(exc).__name__}: {exc}"[:500])
        raise
    store.append_messages(session_id, [m.model_dump(mode="json") for m in [user, *agent.turn_messages]])
    holder["response"] = ChatResponse(session_id=session_id, answer=agent.answer, grounding=agent.grounding, trace_id=trace_id)
    tracer.event(
        trace_id,
        "turn_end",
        latency_ms=round((time.perf_counter() - started) * 1000, 1),
        input_tokens=agent.input_tokens,
        output_tokens=agent.output_tokens,
        cost_usd=_cost(model.id, agent.input_tokens, agent.output_tokens),
    )


async def run_turn(
    message: str,
    session_id: str | None,
    *,
    model: ai.Model,
    store: Store,
    tracer: Tracer,
    max_steps: int = MAX_STEPS,
    registry: Any | None = None,
) -> ChatResponse:
    """Non-streaming turn (used by /chat/json and evals). Raises if the model call fails."""
    holder: dict[str, Any] = {}
    async for _ in _turn_events(
        message, session_id, model=model, store=store, tracer=tracer, max_steps=max_steps, registry=registry, holder=holder
    ):
        pass
    return holder["response"]


def _tool_input(args: str) -> Any:
    try:
        return json.loads(args) if args else {}
    except json.JSONDecodeError:
        return args


async def stream_turn(
    message: str,
    session_id: str | None,
    *,
    model: ai.Model,
    store: Store,
    tracer: Tracer,
    max_steps: int = MAX_STEPS,
    registry: Any | None = None,
) -> AsyncIterator[str]:
    """AI SDK UI message stream (SSE strings): tool parts, one data-answer part, finish, [DONE]."""
    holder: dict[str, Any] = {}
    calls: dict[str, ai.messages.ToolCallPart] = {}
    inputs_sent: set[str] = set()

    async def events() -> AsyncIterator[Any]:
        async for event in _turn_events(
            message, session_id, model=model, store=store, tracer=tracer, max_steps=max_steps, registry=registry, holder=holder
        ):
            if isinstance(event, _TEXT_EVENTS):
                continue  # answer text is never streamed
            if isinstance(event, ai.events.ToolEnd):
                calls[event.tool_call.tool_call_id] = event.tool_call
            yield event

    finish: list[UIFinishEvent] = []
    try:
        async for ui in ai.ui.ai_sdk.to_stream(events()):
            if isinstance(ui, UIFinishEvent):
                finish.append(ui)  # held back until the answer part is out
                continue
            if isinstance(ui, UIToolInputAvailableEvent):
                inputs_sent.add(ui.tool_call_id)
            elif isinstance(ui, (UIToolOutputAvailableEvent, UIToolOutputErrorEvent)) and ui.tool_call_id not in inputs_sent:
                # ai 0.9.0 to_stream never emits tool-input-available for host tools; add it from ToolEnd.
                part = calls.get(ui.tool_call_id)
                if part is not None:
                    inputs_sent.add(ui.tool_call_id)
                    yield format_sse(
                        UIToolInputAvailableEvent(tool_call_id=part.tool_call_id, tool_name=part.tool_name, input=_tool_input(part.tool_args))
                    )
            yield format_sse(ui)
    except Exception:
        # Already traced in _turn_events; the client gets a generic error part.
        yield format_sse(UIErrorEvent(error_text=STREAM_ERROR_TEXT))
        yield format_done_sse()
        return
    yield format_sse(UIDataEvent(data_type="answer", data=holder["response"].model_dump(mode="json")))
    for event in finish or [UIFinishEvent()]:
        yield format_sse(event)
    yield format_done_sse()
