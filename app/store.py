"""SQLite storage (conversations, score history, alerts) and the JSONL tracer.

One short-lived connection per call and an IMMEDIATE transaction for every
read-modify-write, so parallel requests on the same session never lose a turn.
Swapping SQLite for Postgres later only changes this module.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Iterator

from app.schemas import ScoreRow

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    session_id TEXT PRIMARY KEY,
    messages TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS score_history (
    hub_id TEXT NOT NULL,
    computed_at TEXT NOT NULL,
    exposure REAL NOT NULL,
    priority REAL NOT NULL,
    breakdown TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS score_history_hub ON score_history (hub_id, computed_at);
CREATE TABLE IF NOT EXISTS alerts_sent (
    hub_id TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    old REAL NOT NULL,
    new REAL NOT NULL,
    reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS nws_seen (
    key TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL
);
"""


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def trim_to_turns(messages: list[dict], max_messages: int) -> list[dict]:
    """Keep the most recent whole turns that fit in max_messages.

    A turn starts at a user message, so a tool call is never separated from its
    result. The latest turn is always kept, even if it alone is longer.
    """
    starts = [i for i, m in enumerate(messages) if m.get("role") == "user"]
    if not starts:
        return []
    keep_from = starts[-1]
    for start in reversed(starts[:-1]):
        if len(messages) - start > max_messages:
            break
        keep_from = start
    return messages[keep_from:]


class Store:
    def __init__(self, path: Path | str, *, max_messages: int = 20) -> None:
        self.path = Path(path)
        self.max_messages = max_messages
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as conn:
            conn.executescript(_SCHEMA)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            yield conn
        finally:
            conn.close()

    @contextmanager
    def _write(self) -> Iterator[sqlite3.Connection]:
        with self._connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            try:
                yield conn
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            conn.execute("COMMIT")

    # ---------- conversations ----------

    def get_messages(self, session_id: str) -> list[dict]:
        with self._connect() as conn:
            row = conn.execute("SELECT messages FROM conversations WHERE session_id = ?", (session_id,)).fetchone()
        if row is None:
            return []
        return trim_to_turns(json.loads(row[0]), self.max_messages)

    def append_messages(self, session_id: str, new: list[dict]) -> None:
        with self._write() as conn:
            row = conn.execute("SELECT messages FROM conversations WHERE session_id = ?", (session_id,)).fetchone()
            messages = json.loads(row[0]) if row else []
            # Stored history is trimmed on write too (with headroom), so a long session
            # does not grow without bound; reads trim to the exact limit.
            messages = trim_to_turns(messages + new, self.max_messages * 2)
            conn.execute(
                "INSERT INTO conversations (session_id, messages, updated_at) VALUES (?, ?, ?) "
                "ON CONFLICT(session_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at",
                (session_id, json.dumps(messages), _now()),
            )

    # ---------- scores and alerts ----------

    def record_scores(self, rows: list[ScoreRow], computed_at: str) -> None:
        with self._write() as conn:
            conn.executemany(
                "INSERT INTO score_history (hub_id, computed_at, exposure, priority, breakdown) VALUES (?, ?, ?, ?, ?)",
                [(r.hub_id, computed_at, r.exposure, r.priority, r.model_dump_json()) for r in rows],
            )

    def latest_scores(self) -> dict[str, ScoreRow]:
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT s.hub_id, s.breakdown FROM score_history s "
                "JOIN (SELECT hub_id, MAX(computed_at) AS latest FROM score_history GROUP BY hub_id) m "
                "ON s.hub_id = m.hub_id AND s.computed_at = m.latest"
            ).fetchall()
        return {hub_id: ScoreRow.model_validate_json(breakdown) for hub_id, breakdown in rows}

    def record_alert(self, hub_id: str, old: float, new: float, reason: str) -> None:
        with self._write() as conn:
            conn.execute(
                "INSERT INTO alerts_sent (hub_id, sent_at, old, new, reason) VALUES (?, ?, ?, ?, ?)",
                (hub_id, _now(), old, new, reason),
            )

    def alerts(self) -> list[dict[str, Any]]:
        with self._connect() as conn:
            rows = conn.execute("SELECT hub_id, sent_at, old, new, reason FROM alerts_sent ORDER BY rowid").fetchall()
        return [dict(zip(("hub_id", "sent_at", "old", "new", "reason"), r)) for r in rows]


    def swap_nws_seen(self, keys: set[str]) -> set[str]:
        """Replace the NWS alert keys of the previous run with this run's; return the previous ones."""
        with self._write() as conn:
            previous = {row[0] for row in conn.execute("SELECT key FROM nws_seen")}
            conn.execute("DELETE FROM nws_seen")
            now = _now()
            conn.executemany("INSERT INTO nws_seen (key, seen_at) VALUES (?, ?)", [(k, now) for k in sorted(keys)])
        return previous


class Tracer:
    """Appends one JSON line per event; events of one turn share a trace_id."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def event(self, trace_id: str, kind: str, **fields: Any) -> None:
        line = json.dumps({"ts": _now(), "trace_id": trace_id, "kind": kind, **fields}, default=str)
        with self._lock, self.path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
