import json
import threading

from app.schemas import ScoreRow
from app.store import Store, Tracer


def turn(i: int, tool_rounds: int = 0) -> list[dict]:
    msgs = [{"role": "user", "parts": [{"text": f"q{i}"}]}]
    for r in range(tool_rounds):
        msgs.append({"role": "assistant", "parts": [{"tool_call_id": f"c{i}{r}"}]})
        msgs.append({"role": "tool", "parts": [{"tool_call_id": f"c{i}{r}"}]})
    msgs.append({"role": "assistant", "parts": [{"text": f"a{i}"}]})
    return msgs


def test_messages_roundtrip(tmp_path):
    store = Store(tmp_path / "app.db")
    assert store.get_messages("s1") == []
    store.append_messages("s1", turn(1))
    store.append_messages("s1", turn(2))
    assert store.get_messages("s1") == turn(1) + turn(2)
    assert store.get_messages("other") == []


def test_history_trimmed_by_whole_turns(tmp_path):
    store = Store(tmp_path / "app.db", max_messages=20)
    for i in range(10):
        store.append_messages("s", turn(i, tool_rounds=1))  # 4 messages per turn
    history = store.get_messages("s")
    assert len(history) == 20
    assert history[0] == {"role": "user", "parts": [{"text": "q5"}]}
    assert history == [m for i in range(5, 10) for m in turn(i, tool_rounds=1)]


def test_history_keeps_a_single_turn_longer_than_the_limit(tmp_path):
    store = Store(tmp_path / "app.db", max_messages=5)
    store.append_messages("s", turn(0))
    store.append_messages("s", turn(1, tool_rounds=4))  # 10 messages
    history = store.get_messages("s")
    assert history == turn(1, tool_rounds=4)
    # no tool message is left without the assistant call before it
    assert history[0]["role"] == "user"


def test_concurrent_appends_keep_both_turns(tmp_path):
    store = Store(tmp_path / "app.db", max_messages=10_000)
    barrier = threading.Barrier(8)

    def worker(i):
        barrier.wait()
        for j in range(5):
            Store(tmp_path / "app.db", max_messages=10_000).append_messages("same", turn(i * 100 + j))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    history = store.get_messages("same")
    assert len(history) == 8 * 5 * 2
    users = {m["parts"][0]["text"] for m in history if m["role"] == "user"}
    assert users == {f"q{i * 100 + j}" for i in range(8) for j in range(5)}


def row(hub, priority, exposure=50.0):
    return ScoreRow(
        hub_id=hub,
        name=hub.title(),
        region="South",
        exposure=exposure,
        exposure_band="medium",
        priority=priority,
        priority_band="medium",
        top_driver="flood",
        exposure_days_per_year=exposure / 4,
        bad_year_days=exposure / 2,
        hurricane_10yr_probability_pct=0.0,
    )


def test_latest_scores_returns_newest_per_hub(tmp_path):
    store = Store(tmp_path / "app.db")
    assert store.latest_scores() == {}
    store.record_scores([row("dallas", 40.0), row("houston", 50.0)], "2026-11-16T00:00:00Z")
    store.record_scores([row("dallas", 47.5)], "2026-11-17T00:00:00Z")
    latest = store.latest_scores()
    assert latest["dallas"].priority == 47.5
    assert latest["houston"].priority == 50.0


def test_record_alert(tmp_path):
    store = Store(tmp_path / "app.db")
    store.record_alert("dallas", 40.0, 47.5, "priority +7.5")
    assert store.alerts() == [
        {"hub_id": "dallas", "old": 40.0, "new": 47.5, "reason": "priority +7.5", "sent_at": store.alerts()[0]["sent_at"]}
    ]


def test_tracer_writes_jsonl(tmp_path):
    path = tmp_path / "logs" / "traces.jsonl"
    tracer = Tracer(path)
    tracer.event("t1", "user_message", text="hi")
    tracer.event("t1", "tool_call", name="rank_hubs", latency_ms=3.2)
    lines = [json.loads(line) for line in path.read_text().splitlines()]
    assert [line["kind"] for line in lines] == ["user_message", "tool_call"]
    assert lines[1]["trace_id"] == "t1" and lines[1]["name"] == "rank_hubs"
    assert "ts" in lines[0]
