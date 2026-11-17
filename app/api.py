"""FastAPI app: /chat (AI SDK UI stream), /chat/json, /hubs, /scores, /alerts/check, /health.

Everything heavy (model, store, scoring data) is resolved on first use, so importing
this module needs no API key and no data files.
"""

from __future__ import annotations

import hmac
import os
import threading
import time
import uuid
from collections import defaultdict, deque
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict

from app import agent
from app.schemas import ChatRequest, ChatResponse, Hub, ScoreRow, WhatIfInput, WhatIfResult
from app.store import Store, Tracer

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
MAX_MESSAGE_CHARS = 2000
UNAVAILABLE = "The model or an upstream service is unavailable. Please try again later."


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


def client_ip(request: Request, hops: int = 1) -> str:
    """The client IP as seen by our trusted proxy.

    Each proxy appends the address it received the request from, so the entry `hops` places
    from the right was written by the outermost trusted proxy. Entries further left are
    client-controlled and are ignored (they could be rotated to dodge the rate limit).
    """
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
) -> FastAPI:
    from dotenv import load_dotenv

    load_dotenv()
    limiter = RateLimiter(_env_int("RATE_LIMIT_PER_MIN", 10), _env_int("DAILY_REQUEST_CAP", 300))
    proxy_hops = _env_int("TRUSTED_PROXY_HOPS", 1)
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
        refused = limiter.check(client_ip(request, proxy_hops))
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
        stream = agent.stream_turn(
            text, body.id or uuid.uuid4().hex, model=m, store=get("store"), tracer=get("tracer"), registry=registry
        )
        return StreamingResponse(stream, headers=ai.ui.ai_sdk.UI_MESSAGE_STREAM_HEADERS, media_type="text/event-stream")

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
        return alerts.check_alerts(
            get("store"), rows, webhook_url, nws_fetch if nws_fetch is not None else alerts.fetch_severe_nws, **kwargs
        )

    dist = ROOT / "web" / "dist"
    if (dist / "index.html").exists():
        app.mount("/", StaticFiles(directory=dist, html=True), name="web")

    return app


app = create_app()
