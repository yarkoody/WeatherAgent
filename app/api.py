"""FastAPI app: /chat (AI SDK UI stream), /chat/json, /hubs, /scores, /alerts/check, /health.

Everything heavy (model, store, scoring data) is resolved on first use, so importing
this module needs no API key and no data files.
"""

from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
import os
import threading
import time
import uuid
from collections import defaultdict, deque
from collections.abc import AsyncIterator, Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict

from app import agent
from app.schemas import ChatRequest, ChatResponse, Hub, HubHistory, HubScore, ScoreRow, SecondOpinion, WhatIfInput, WhatIfResult
from app.store import Store, Tracer

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
MAX_MESSAGE_CHARS = 2000
UNAVAILABLE = "The model or an upstream service is unavailable. Please try again later."
log = logging.getLogger("app.api")


def _ensure_log_output() -> None:
    """Uvicorn configures only its own loggers, so INFO lines from app.api would be dropped.

    Add a stderr handler when nothing else would show them (no handler here or on the root logger).
    """
    if log.handlers or logging.getLogger().handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    log.addHandler(handler)
    log.setLevel(logging.INFO)


async def logged_stream(chunks: AsyncIterator[str], info: dict[str, Any], *, keepalive_seconds: float) -> AsyncIterator[str]:
    """The /chat stream with keepalives, and one log line per turn when it ends.

    The line says who ended the stream: completed, error (the turn failed and sent its fallback
    answer) or client_disconnected (the browser or a proxy closed it before [DONE]). It never
    carries the message text or the client IP.
    """
    started = time.perf_counter()
    outcome = "client_disconnected"
    try:
        # aclosing: when the client goes away, close the keepalive stream at once, which stops the turn.
        async with contextlib.aclosing(agent.with_keepalive(chunks, keepalive_seconds)) as stream:
            async for chunk in stream:
                yield chunk
        outcome = info.get("outcome", "completed")
    except (asyncio.CancelledError, GeneratorExit):
        outcome = "client_disconnected"
        raise
    except Exception:
        outcome = "error"
        raise
    finally:
        log.info(
            "chat turn trace_id=%s duration_ms=%d tools=%d outcome=%s",
            info.get("trace_id", "-"),
            (time.perf_counter() - started) * 1000,
            info.get("tools", 0),
            outcome,
        )


class UIChatRequest(BaseModel):
    """The useChat (AI SDK UI v5) request body. Extra fields (trigger, messageId, ...) are allowed."""

    model_config = ConfigDict(extra="allow")
    id: str | None = None
    messages: list[dict[str, Any]]


def last_user_text(messages: list[dict[str, Any]]) -> str | None:
    for message in reversed(messages):
        if message.get("role") == "user":
            parts = message.get("parts") or []
            return "".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text")
    return None


def _text_of(message: dict[str, Any]) -> str:
    parts = message.get("parts")
    if not isinstance(parts, list):
        return ""
    return "".join(p.get("text", "") for p in parts if isinstance(p, dict) and p.get("type") == "text" and isinstance(p.get("text"), str))


def _answer_of(message: dict[str, Any]) -> str:
    """The answer text of an assistant UIMessage's data-answer part ("" if there is none)."""
    parts = message.get("parts")
    for part in parts if isinstance(parts, list) else []:
        if isinstance(part, dict) and part.get("type") == "data-answer" and isinstance(part.get("data"), dict):
            answer = part["data"].get("answer")
            text = answer.get("answer") if isinstance(answer, dict) else None
            if isinstance(text, str):
                return text
    return ""


def client_history(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """Earlier complete turns from the browser's copy of the chat, before the new user message.

    Only user text and the verified answer text (data-answer) are kept; tool parts, system and
    tool roles are dropped, and a user message without an answer is skipped. The text is
    untrusted user content: the agent caps it and never treats it as tool data.
    """
    last_user = max((i for i, m in enumerate(messages) if isinstance(m, dict) and m.get("role") == "user"), default=None)
    out: list[dict[str, str]] = []
    pending: str | None = None
    for message in messages[:last_user] if last_user is not None else []:
        if not isinstance(message, dict):
            continue
        if message.get("role") == "user":
            pending = _text_of(message).strip() or None
        elif message.get("role") == "assistant" and pending is not None:
            answer = _answer_of(message).strip()
            if answer:
                out += [{"role": "user", "text": pending}, {"role": "assistant", "text": answer}]
                pending = None
    return out


def check_message(text: str | None) -> str:
    if text is None:
        raise HTTPException(422, "The request has no user message.")
    if not text.strip():
        raise HTTPException(422, "The message is empty.")
    if len(text) > MAX_MESSAGE_CHARS:
        raise HTTPException(422, f"The message is longer than {MAX_MESSAGE_CHARS} characters.")
    return text


class RateLimiter:
    """In-memory limits: requests per IP per minute and requests per server per UTC day.

    Counters reset on restart (stated in the README); fine for one demo instance.
    """

    def __init__(self, per_minute: int, daily_cap: int, clock: Callable[[], float] = time.monotonic) -> None:
        self.per_minute = per_minute
        self.daily_cap = daily_cap
        self.clock = clock
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._day = ""
        self._day_count = 0
        self._last_sweep = clock()
        self._lock = threading.Lock()

    def _sweep(self, now: float) -> None:
        """Forget IPs with no request in the last minute, so memory stays bounded."""
        if now - self._last_sweep < 60:
            return
        self._last_sweep = now
        for ip in [ip for ip, hits in self._hits.items() if not hits or now - hits[-1] >= 60]:
            del self._hits[ip]

    def check(self, ip: str) -> str | None:
        """Count the request and return None, or return why it is refused."""
        with self._lock:
            now = self.clock()
            self._sweep(now)
            today = datetime.now(UTC).date().isoformat()
            if today != self._day:
                self._day, self._day_count = today, 0
            if self._day_count >= self.daily_cap:
                return "The daily request cap for this demo has been reached. Please try again tomorrow."
            hits = self._hits[ip]
            while hits and now - hits[0] >= 60:
                hits.popleft()
            if len(hits) >= self.per_minute:
                return f"Rate limit: at most {self.per_minute} requests per minute. Please wait a moment."
            hits.append(now)
            self._day_count += 1
            return None


def client_ip(request: Request, hops: int = 1, header: str = "") -> str:
    """The client IP as seen by our trusted proxy.

    If `header` is set (CLIENT_IP_HEADER, e.g. "cf-connecting-ip" on Render, which sits behind
    Cloudflare) and present, it wins: the edge proxy overwrites it, so clients cannot spoof it.

    Each proxy appends the address it received the request from, so the entry `hops` places
    from the right was written by the outermost trusted proxy. Entries further left are
    client-controlled and are ignored (they could be rotated to dodge the rate limit).
    """
    if header:
        value = (request.headers.get(header) or "").strip()
        if value:
            return value
    forwarded = [p.strip() for p in (request.headers.get("x-forwarded-for") or "").split(",") if p.strip()]
    if forwarded:
        return forwarded[max(len(forwarded) - max(hops, 1), 0)]
    return request.client.host if request.client else "unknown"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def create_app(
    model: Any = None,
    store: Store | None = None,
    *,
    tracer: Tracer | None = None,
    registry: Any = None,
    compute_rows: Callable[[], list[ScoreRow]] | None = None,
    list_hubs: Callable[[], list[Hub]] | None = None,
    nws_fetch: Callable[[], list[dict]] | None = None,
    baseline_path: Path | None = None,
    alerts_log: Path | None = None,
    second_opinion_path: Path | None = None,
    second_opinion_builder: Callable[[], Any] | None = None,
    keepalive_seconds: float = agent.KEEPALIVE_SECONDS,
) -> FastAPI:
    _ensure_log_output()
    from dotenv import load_dotenv

    load_dotenv()
    limiter = RateLimiter(_env_int("RATE_LIMIT_PER_MIN", 10), _env_int("DAILY_REQUEST_CAP", 300))
    proxy_hops = _env_int("TRUSTED_PROXY_HOPS", 1)
    ip_header = os.environ.get("CLIENT_IP_HEADER", "").strip().lower()
    alert_token = os.environ.get("ALERT_TOKEN", "")
    webhook_url = os.environ.get("ALERT_WEBHOOK_URL", "") or None
    lazy: dict[str, Any] = {"model": model, "store": store, "tracer": tracer}
    lock = threading.Lock()

    def get(name: str) -> Any:
        with lock:
            if lazy[name] is None:
                if name == "model":
                    lazy[name] = agent.get_model()
                elif name == "store":
                    lazy[name] = Store(DATA_DIR / "app.db")
                else:
                    lazy[name] = Tracer(ROOT / "logs" / "traces.jsonl")
            return lazy[name]

    def resolve_model() -> Any:
        try:
            return get("model")
        except Exception as exc:
            raise HTTPException(503, UNAVAILABLE) from exc

    def rows() -> list[ScoreRow]:
        if compute_rows is not None:
            result = compute_rows()
        else:
            from app import alerts

            result = alerts.snapshot_rows()
        return sorted(result, key=lambda r: (-r.priority, r.hub_id))

    def limit(request: Request) -> None:
        refused = limiter.check(client_ip(request, proxy_hops, ip_header))
        if refused:
            raise HTTPException(429, refused)

    app = FastAPI(title="Weather Risk Intelligence Agent")

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        details = "; ".join(f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in exc.errors())
        return JSONResponse(status_code=422, content={"detail": details or "Validation failed."})

    @app.exception_handler(Exception)
    async def unexpected_error(_: Request, exc: Exception) -> JSONResponse:
        return JSONResponse(status_code=500, content={"detail": "Internal server error."})

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/chat")
    async def chat(body: UIChatRequest, request: Request) -> StreamingResponse:
        import ai.ui.ai_sdk

        text = check_message(last_user_text(body.messages))
        limit(request)
        m = resolve_model()
        info: dict[str, Any] = {}
        stream = agent.stream_turn(
            text,
            body.id or uuid.uuid4().hex,
            model=m,
            store=get("store"),
            tracer=get("tracer"),
            registry=registry,
            client_history=client_history(body.messages),
            info=info,
        )
        return StreamingResponse(
            logged_stream(stream, info, keepalive_seconds=keepalive_seconds),
            headers=ai.ui.ai_sdk.UI_MESSAGE_STREAM_HEADERS,
            media_type="text/event-stream",
        )

    @app.post("/chat/json")
    async def chat_json(body: ChatRequest, request: Request) -> ChatResponse:
        text = check_message(body.message)
        limit(request)
        m = resolve_model()
        try:
            return await agent.run_turn(text, body.session_id, model=m, store=get("store"), tracer=get("tracer"), registry=registry)
        except Exception as exc:
            raise HTTPException(503, UNAVAILABLE) from exc

    @app.get("/hubs")
    def hubs() -> list[Hub]:
        if list_hubs is not None:
            return list_hubs()
        from app import scoring

        return scoring.load_hubs()

    @app.get("/scores")
    def scores() -> list[ScoreRow]:
        return rows()

    @app.post("/what-if")
    def what_if(body: WhatIfInput, request: Request) -> WhatIfResult:
        """Deterministic re-ranking with analyst-supplied weights and costs. No LLM call."""
        limit(request)
        from app import scoring

        try:
            return scoring.what_if(scoring.load_hubs(), scoring.load_snapshot(), body)
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    async def hub_tool(tool: str, hub_id: str, request: Request, response: Response) -> dict[str, Any]:
        """Run a one-hub tool for a REST route: same name resolution as the agent, 404 on a ToolError.

        A name resolved through a nickname or a metro area gets an X-Resolution-Note header (the
        schemas have no field for it).
        """
        limit(request)
        import json as json_

        from app import tools

        out = await tools.run_tool(tool, json_.dumps({"hub_id": hub_id}))
        if not isinstance(out, dict) or "error" in out:
            detail = f"{out.get('error')}. {out.get('hint')}" if isinstance(out, dict) else "Unknown hub."
            raise HTTPException(404, detail)
        notes = out.pop("resolution_notes", None)
        if notes:
            # headers are latin-1: keep the note ASCII so an accented city name cannot break the response
            response.headers["X-Resolution-Note"] = " ".join(notes).encode("ascii", "replace").decode()
        return out

    @app.get("/hubs/{hub_id}/score")
    async def hub_score(hub_id: str, request: Request, response: Response) -> HubScore:
        """One hub's full breakdown (the get_hub_risk tool's result), for the map. No LLM call."""
        return HubScore.model_validate(await hub_tool("get_hub_risk", hub_id, request, response))

    @app.get("/hubs/{hub_id}/history")
    async def hub_history(hub_id: str, request: Request, response: Response) -> HubHistory:
        """One hub's observed yearly and monthly disruption days (the get_hub_history tool's result). No LLM call."""
        return HubHistory.model_validate(await hub_tool("get_hub_history", hub_id, request, response))

    opinion_path = second_opinion_path or DATA_DIR / "jev_second_opinion.json"

    @app.get("/second-opinion")
    def second_opinion() -> SecondOpinion:
        """The last offline JEV cross-check, read from a committed file. No live JEV call."""
        if not opinion_path.exists():
            raise HTTPException(404, "No JEV second opinion has been run yet.")
        return SecondOpinion.model_validate_json(opinion_path.read_text())

    @app.post("/second-opinion/rerun")
    async def second_opinion_rerun(request: Request) -> SecondOpinion:
        """Developer-only rerun. Enabled only where JEV_RERUN_ENABLED=1 and a TypeSafe key exist (a local machine)."""
        if os.environ.get("JEV_RERUN_ENABLED") != "1" or not os.environ.get("TYPESAFE_API_KEY"):
            raise HTTPException(503, "JEV rerun is only available when running locally with JEV_RERUN_ENABLED=1 and a TypeSafe key.")
        limit(request)
        builder = second_opinion_builder
        if builder is None:
            from app.second_opinion import build_second_opinion as builder
        try:
            result = await builder()
        except Exception as exc:
            raise HTTPException(503, "The JEV run failed. Try again later.") from exc
        tmp = opinion_path.with_suffix(".tmp")
        tmp.write_text(result.model_dump_json(indent=2))
        tmp.replace(opinion_path)
        return result

    @app.post("/alerts/check")
    def alerts_check(x_alert_token: str | None = Header(default=None)) -> dict[str, Any]:
        if not alert_token or not hmac.compare_digest((x_alert_token or "").encode(), alert_token.encode()):
            raise HTTPException(401, "Missing or wrong X-Alert-Token.")
        from app import alerts

        kwargs: dict[str, Any] = {}
        if baseline_path is not None:
            kwargs["baseline_path"] = baseline_path
        if alerts_log is not None:
            kwargs["log_path"] = alerts_log
            kwargs["state_path"] = alerts_log.with_name("alert_state.json")
        return alerts.check_alerts(
            get("store"), rows, webhook_url, nws_fetch if nws_fetch is not None else alerts.fetch_severe_nws, **kwargs
        )

    dist = ROOT / "web" / "dist"
    if (dist / "index.html").exists():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")

    return app


app = create_app()
