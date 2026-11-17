"""Live voice mode: speech in through OpenAI realtime transcription, speech out through OpenAI TTS.

The model never answers by voice. The browser streams the microphone to a transcription-only realtime
session (WebRTC, ephemeral client secret minted here, so the API key never leaves the server); each
finished utterance goes through the normal /chat turn (tools + grounding); and only the verified answer
the server produced for that turn is spoken, looked up by its trace id. A speech-to-speech model would
speak numbers no tool returned and no grounding check saw.

Protection: /voice/session is rate limited like /chat, has a server-wide daily cap on sessions, and
each session is capped at VOICE_SESSION_SECONDS (the browser ends it; the ephemeral secret only lets a
session start for 60 s). /voice/speak only speaks an answer this server just verified, at most twice
per answer, so its cost is bounded by chat turns.
"""

from __future__ import annotations

import os
import re
import threading
from collections import OrderedDict
from datetime import UTC, datetime
from typing import Any

import httpx

from app.schemas import ChatResponse

OPENAI_BASE = "https://api.openai.com/v1"
CONNECT_URL = f"{OPENAI_BASE}/realtime/calls"
SECRET_TTL_SECONDS = 60  # the secret only has to open the WebRTC call
DEFAULT_TRANSCRIBE_MODEL = "gpt-4o-transcribe"
DEFAULT_TTS_MODEL = "gpt-4o-mini-tts"
DEFAULT_TTS_VOICE = "marin"
MAX_SPEECH_CHARS = 2500
MAX_SPEAKS_PER_ANSWER = 2
TTS_INSTRUCTIONS = (
    "Speak clearly and calmly at a natural pace, like an operations analyst briefing a colleague. "
    "Read numbers exactly as written."
)
# Biases recognition toward the hub names and terms analysts say.
TRANSCRIBE_PROMPT = (
    "Questions about weather risk at US logistics hubs: Chicago, Minneapolis, Detroit, Indianapolis, Kansas City, "
    "KC, Columbus, Dallas, DFW, Houston, Miami, Atlanta, Memphis, Denver, Phoenix, Los Angeles, Newark. "
    "Terms: exposure, review priority, hurricane, flood, winter, severe storm, NWS alerts, what-if."
)
UNVERIFIED_SPEECH = (
    "I couldn't verify every number in this answer, so I won't read it aloud. "
    "It's on screen, with the unchecked figures removed."
)


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


def session_seconds() -> int:
    return max(60, _env_int("VOICE_SESSION_SECONDS", 600))


def transcription_session(model: str | None = None) -> dict[str, Any]:
    """The client-secret request body for a transcription-only realtime session (no model replies)."""
    return {
        "expires_after": {"anchor": "created_at", "seconds": SECRET_TTL_SECONDS},
        "session": {
            "type": "transcription",
            "audio": {
                "input": {
                    "noise_reduction": {"type": "near_field"},
                    "transcription": {
                        "model": model or os.environ.get("VOICE_TRANSCRIBE_MODEL", "").strip() or DEFAULT_TRANSCRIBE_MODEL,
                        "prompt": TRANSCRIBE_PROMPT,
                    },
                    "turn_detection": {"type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300, "silence_duration_ms": 700},
                }
            },
        },
    }


class DailyCap:
    """Server-wide count per UTC day (resets on restart, like the chat limiter)."""

    def __init__(self, cap: int) -> None:
        self.cap = cap
        self._day = ""
        self._count = 0
        self._lock = threading.Lock()

    def take(self) -> bool:
        with self._lock:
            today = datetime.now(UTC).date().isoformat()
            if today != self._day:
                self._day, self._count = today, 0
            if self._count >= self.cap:
                return False
            self._count += 1
            return True


class UpstreamError(Exception):
    pass


async def create_session(api_key: str, *, client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    """Mint an ephemeral client secret for one transcription session. Returns what the browser needs."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=15)
    try:
        resp = await client.post(
            f"{OPENAI_BASE}/realtime/client_secrets",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=transcription_session(),
        )
    except httpx.HTTPError as exc:
        raise UpstreamError(type(exc).__name__) from exc
    finally:
        if own:
            await client.aclose()
    if resp.status_code != 200:
        raise UpstreamError(f"client_secrets returned {resp.status_code}")
    body = resp.json()
    value = body.get("value") or (body.get("client_secret") or {}).get("value")
    if not isinstance(value, str) or not value:
        raise UpstreamError("no client secret in the response")
    transcription = (((body.get("session") or {}).get("audio") or {}).get("input") or {}).get("transcription") or {}
    return {
        "client_secret": value,
        "expires_at": body.get("expires_at"),
        "connect_url": CONNECT_URL,
        "transcribe_model": transcription.get("model") or transcription_session()["session"]["audio"]["input"]["transcription"]["model"],
        "max_session_seconds": session_seconds(),
    }


# ---------- speaking verified answers ----------


def to_speech(markdown: str) -> str:
    """Markdown to plain text that reads well aloud (same rules as the browser's read-aloud)."""
    text = re.sub(r"```[\s\S]*?```", " ", markdown)
    text = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"[*_`#>|]", "", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > MAX_SPEECH_CHARS:
        cut = text[:MAX_SPEECH_CHARS]
        end = max(cut.rfind(". "), cut.rfind("? "), cut.rfind("! "))
        text = (cut[: end + 1] if end > MAX_SPEECH_CHARS // 2 else cut) + " The rest is on screen."
    return text


def speech_for(response: ChatResponse) -> str:
    """What live mode says for a turn: the verified answer text, or a notice when grounding failed."""
    if response.grounding.status == "failed":
        return UNVERIFIED_SPEECH
    return to_speech(response.answer.answer)


class SpokenAnswers:
    """The speech text of recent verified answers, by trace id. Bounded; each answer is spoken at most twice."""

    def __init__(self, max_items: int = 500) -> None:
        self.max_items = max_items
        self._items: OrderedDict[str, list[Any]] = OrderedDict()
        self._lock = threading.Lock()

    def add(self, response: ChatResponse) -> None:
        with self._lock:
            self._items[response.trace_id] = [speech_for(response), 0]
            self._items.move_to_end(response.trace_id)
            while len(self._items) > self.max_items:
                self._items.popitem(last=False)

    def take(self, trace_id: str) -> str | None:
        """The text to speak, or None if unknown or already spoken MAX_SPEAKS_PER_ANSWER times."""
        with self._lock:
            item = self._items.get(trace_id)
            if item is None or item[1] >= MAX_SPEAKS_PER_ANSWER:
                return None
            item[1] += 1
            return item[0]


def tts_request(text: str) -> dict[str, Any]:
    return {
        "model": os.environ.get("VOICE_TTS_MODEL", "").strip() or DEFAULT_TTS_MODEL,
        "voice": os.environ.get("VOICE_TTS_VOICE", "").strip() or DEFAULT_TTS_VOICE,
        "input": text,
        "instructions": TTS_INSTRUCTIONS,
        "response_format": "mp3",
    }


async def open_speech(api_key: str, text: str, *, client: httpx.AsyncClient | None = None) -> tuple[httpx.AsyncClient, httpx.Response]:
    """Start a streaming TTS request. The caller streams resp.aiter_bytes() and closes both."""
    own = client is None
    client = client or httpx.AsyncClient(timeout=httpx.Timeout(30, read=60))
    try:
        req = client.build_request(
            "POST",
            f"{OPENAI_BASE}/audio/speech",
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
            json=tts_request(text),
        )
        resp = await client.send(req, stream=True)
    except httpx.HTTPError as exc:
        if own:
            await client.aclose()
        raise UpstreamError(type(exc).__name__) from exc
    if resp.status_code != 200:
        await resp.aclose()
        if own:
            await client.aclose()
        raise UpstreamError(f"audio/speech returned {resp.status_code}")
    return client, resp
