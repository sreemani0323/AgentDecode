import json
import sys
from pathlib import Path

# Ensure local agentdecode package is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest
from unittest.mock import MagicMock

from agentdecode.tracer import (
    AgentDecode,
    MAX_SAFE_INGEST_PAYLOAD_BYTES,
    _split_spans_into_bounded_chunks,
)
from agentdecode.wal import SQLiteWAL


def test_split_spans_into_bounded_chunks_partitions_oversized():
    base_payload = {
        "session_name": "Test Large Session",
        "session_id": "sess-big",
    }
    large_str = "x" * (500 * 1024)  # 500 KB per span
    spans = [
        {
            "name": f"span_{i}",
            "span_type": "tool",
            "status": "ok",
            "started_at": "2026-11-04T00:00:00Z",
            "client_span_id": f"span-{i}",
            "parent_client_span_id": f"span-{i-1}" if i > 0 else None,
            "input": {"data": large_str},
        }
        for i in range(10)
    ]

    # Total payload > 5 MB
    total_bytes = len(
        json.dumps({**base_payload, "spans": spans}).encode("utf-8")
    )
    assert total_bytes > 4 * 1024 * 1024

    chunks = _split_spans_into_bounded_chunks(
        spans, base_payload, max_bytes=MAX_SAFE_INGEST_PAYLOAD_BYTES
    )

    assert len(chunks) > 1

    # Verify each chunk is <= MAX_SAFE_INGEST_PAYLOAD_BYTES
    total_spans = 0
    for chunk in chunks:
        total_spans += len(chunk)
        chunk_payload = {**base_payload, "spans": chunk}
        chunk_bytes = len(json.dumps(chunk_payload).encode("utf-8"))
        assert chunk_bytes <= MAX_SAFE_INGEST_PAYLOAD_BYTES

    assert total_spans == 10
    flat_ids = [s["client_span_id"] for chunk in chunks for s in chunk]
    assert flat_ids == [s["client_span_id"] for s in spans]


def test_session_flush_splits_oversized_payload(tmp_path):
    db_file = str(tmp_path / "test_wal.db")
    wal = SQLiteWAL(db_path=db_file)
    received_requests = []

    def mock_send(payload):
        payload_bytes = len(json.dumps(payload).encode("utf-8"))
        received_requests.append((payload, payload_bytes))
        return {"received": 1}

    agent = AgentDecode(
        api_key="al_test",
        endpoint="https://example.com",
        wal_path=db_file,
    )

    with agent.session("Oversized Run", _send_fn=mock_send) as sess:
        large_str = "a" * (500 * 1024)
        for i in range(8):
            with sess.span(f"span_{i}", span_type="tool") as sp:
                sp.input = {"data": large_str}

    # Verify multiple requests sent, each <= 3.5 MiB
    assert len(received_requests) >= 2
    for payload, byte_size in received_requests:
        assert byte_size <= MAX_SAFE_INGEST_PAYLOAD_BYTES
        assert payload["session_name"] == "Oversized Run"

    # All 8 spans received across chunks
    all_spans = [s for payload, _ in received_requests for s in payload["spans"]]
    assert len(all_spans) == 8

    # WAL empty after successful acknowledgments
    assert len(agent.wal.get_pending()) == 0


def test_session_flush_partial_failure_preserves_wal(tmp_path):
    db_file = str(tmp_path / "test_wal_fail.db")
    wal = SQLiteWAL(db_path=db_file)
    calls = 0

    def mock_send(payload):
        nonlocal calls
        calls += 1
        if calls == 1:
            return {"received": 1}
        raise RuntimeError("Server unavailable")

    agent = AgentDecode(
        api_key="al_test",
        endpoint="https://example.com",
        wal_path=db_file,
    )

    with agent.session("Partial Fail Run", _send_fn=mock_send) as sess:
        large_str = "b" * (500 * 1024)
        for i in range(8):
            with sess.span(f"span_{i}", span_type="tool") as sp:
                sp.input = {"data": large_str}

    # Chunk 1 acknowledged, chunk 2 recorded retry and preserved in WAL
    pending = agent.wal.get_pending()
    assert len(pending) == 1
    assert pending[0].attempts == 1
    assert "Server unavailable" in (pending[0].last_error or "")
    assert len(pending[0].payload["spans"]) < 8


def test_agent_flush_recovers_oversized_wal_batch(tmp_path):
    db_file = str(tmp_path / "test_wal_rec.db")
    wal = SQLiteWAL(db_path=db_file)

    large_str = "c" * (500 * 1024)
    spans = [
        {
            "name": f"span_{i}",
            "span_type": "chain",
            "status": "ok",
            "started_at": "2026-11-04T00:00:00Z",
            "client_span_id": f"rec-span-{i}",
            "input": {"data": large_str},
        }
        for i in range(8)
    ]
    # Enqueue an oversized batch directly into WAL
    wal.enqueue(
        payload={
            "session_name": "Recovered Session",
            "session_id": "rec-sess-1",
            "spans": spans,
        },
        session_name="Recovered Session",
        session_id="rec-sess-1",
    )

    agent = AgentDecode(
        api_key="al_test",
        wal_path=db_file,
    )

    received_batches = []

    def mock_sender(payload):
        b_size = len(json.dumps(payload).encode("utf-8"))
        received_batches.append((payload, b_size))

    acked = agent.flush(send_fn=mock_sender)

    assert acked == 1
    assert len(received_batches) >= 2
    for payload, b_size in received_batches:
        assert b_size <= MAX_SAFE_INGEST_PAYLOAD_BYTES

    # Verify WAL empty
    assert len(agent.wal.get_pending()) == 0
