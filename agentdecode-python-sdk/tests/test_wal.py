"""
Automated tests for AgentDecode Python SDK Persistent Write-Ahead Log (WAL).

Verifies durability, synchronous mode verification, zero FIFO eviction, crash recovery
with subprocess termination, retries with jitter, dead-letter inspection & requeue,
bounded capacity, corruption sidecar quarantine, and concurrent access.
"""

import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from urllib.error import HTTPError
import pytest

from agentdecode import (
    AgentDecode,
    Session,
    SQLiteWAL,
    WALCapacityError,
    WALStorageError,
)
from agentdecode.tracer import HTTPClientError


@pytest.fixture
def temp_wal_dir():
    d = tempfile.mkdtemp(prefix="agentdecode_wal_test_")
    yield d
    shutil.rmtree(d, ignore_errors=True)


def test_wal_synchronous_mode_full_verified(temp_wal_dir):
    """Verify that default synchronous mode is FULL and PRAGMA settings are verified."""
    db_path = os.path.join(temp_wal_dir, "sync_test.db")
    wal = SQLiteWAL(db_path=db_path)
    try:
        stats = wal.get_stats()
        assert stats["synchronous_mode"] == "FULL"
        assert stats["is_durable"] is True
        assert stats["storage_type"] == "sqlite-wal"

        # Check raw database pragmas directly
        raw_conn = sqlite3.connect(db_path)
        cur = raw_conn.execute("PRAGMA journal_mode;")
        assert cur.fetchone()[0].lower() == "wal"
        cur = raw_conn.execute("PRAGMA synchronous;")
        # SQLite: 2 = FULL
        assert cur.fetchone()[0] == 2
        raw_conn.close()
    finally:
        wal.close()


def test_wal_enqueue_and_get_pending(temp_wal_dir):
    db_path = os.path.join(temp_wal_dir, "test.db")
    wal = SQLiteWAL(db_path=db_path)
    try:
        assert wal.count_pending() == 0

        payload = {"session_name": "test_session", "spans": [{"name": "span1"}]}
        batch_id = wal.enqueue(payload, session_name="test_session")
        assert batch_id is not None
        assert wal.count_pending() == 1

        pending = wal.get_pending()
        assert len(pending) == 1
        assert pending[0].id == batch_id
        assert pending[0].session_name == "test_session"
        assert pending[0].payload == payload
        assert pending[0].status == "pending"
        assert pending[0].attempts == 0
    finally:
        wal.close()


def test_wal_acknowledgment_deletes_batch(temp_wal_dir):
    db_path = os.path.join(temp_wal_dir, "test.db")
    wal = SQLiteWAL(db_path=db_path)
    try:
        payload = {"session_name": "ack_test", "spans": []}
        batch_id = wal.enqueue(payload, session_name="ack_test")
        assert wal.count_pending() == 1

        wal.acknowledge(batch_id)
        assert wal.count_pending() == 0
        assert len(wal.get_pending()) == 0
    finally:
        wal.close()


def test_wal_transient_failure_records_retry(temp_wal_dir):
    db_path = os.path.join(temp_wal_dir, "test.db")
    wal = SQLiteWAL(db_path=db_path)
    try:
        payload = {"session_name": "retry_test", "spans": []}
        batch_id = wal.enqueue(payload, session_name="retry_test")
        wal.mark_sending([batch_id])

        wal.record_retry(batch_id, "HTTP 503 Service Unavailable")

        assert wal.count_pending() == 1
        pending = wal.get_pending()
        assert len(pending) == 1
        assert pending[0].id == batch_id
        assert pending[0].status == "pending"
        assert pending[0].attempts == 1
        assert "503" in pending[0].last_error
    finally:
        wal.close()


def test_wal_capacity_reached_rejects_without_eviction(temp_wal_dir):
    """Never evict unacknowledged pending batches; reject new enqueue with WALCapacityError."""
    db_path = os.path.join(temp_wal_dir, "capacity.db")
    wal = SQLiteWAL(db_path=db_path, max_entries=3)
    try:
        id1 = wal.enqueue({"n": 1}, session_name="s1")
        id2 = wal.enqueue({"n": 2}, session_name="s2")
        id3 = wal.enqueue({"n": 3}, session_name="s3")
        assert wal.count_pending() == 3

        # 4th batch must raise WALCapacityError, NOT silently evict id1!
        with pytest.raises(WALCapacityError) as exc_info:
            wal.enqueue({"n": 4}, session_name="s4")

        assert "capacity limit reached" in str(exc_info.value)
        # All 3 original batches must remain intact
        assert wal.count_pending() == 3
        pending_ids = [b.id for b in wal.get_pending()]
        assert pending_ids == [id1, id2, id3]
    finally:
        wal.close()


def test_wal_dead_letter_inspection_and_requeue(temp_wal_dir):
    """Dead letter records are preserved, inspectable, and can be requeued."""
    db_path = os.path.join(temp_wal_dir, "dead_letter.db")
    wal = SQLiteWAL(db_path=db_path)
    try:
        b1 = wal.enqueue({"span": 1}, session_name="b1")
        b2 = wal.enqueue({"span": 2}, session_name="b2")

        wal.record_permanent_failure(b1, "HTTP 400 Bad Request: Invalid token")
        assert wal.count_pending() == 1
        assert wal.count_dead_letter() == 1

        # Inspect dead letter entries
        dl_entries = wal.get_dead_letter()
        assert len(dl_entries) == 1
        assert dl_entries[0].id == b1
        assert "400" in dl_entries[0].error_message
        assert dl_entries[0].attempts >= 1

        # Requeue dead letter batch back to active pending queue
        requeued = wal.requeue_dead_letter([b1])
        assert requeued == 1
        assert wal.count_dead_letter() == 0
        assert wal.count_pending() == 2
        pending_ids = [b.id for b in wal.get_pending()]
        assert b1 in pending_ids
        assert b2 in pending_ids
    finally:
        wal.close()


def test_wal_corruption_quarantines_sidecars(temp_wal_dir):
    """Corrupted database moves db, -wal, and -shm sidecars together into quarantine directory."""
    db_path = os.path.join(temp_wal_dir, "corrupt.db")
    wal = SQLiteWAL(db_path=db_path)
    wal.enqueue({"n": 1}, session_name="s1")
    wal.close()

    # Corrupt the main file
    with open(db_path, "wb") as f:
        f.write(b"CORRUPTED_DATABASE_HEADER_DATA_GARBAGE_1234567890")

    # Reopening should detect corruption and quarantine sidecars
    recovered_wal = SQLiteWAL(db_path=db_path)
    try:
        assert recovered_wal.count_pending() == 0
        stats = recovered_wal.get_stats()
        assert stats["has_quarantined_data"] is True
        assert len(stats["quarantined_paths"]) >= 1

        # Verify quarantine directory exists and contains preserved files
        q_dir = stats["quarantined_paths"][0]
        assert os.path.exists(q_dir)
        q_files = os.listdir(q_dir)
        assert any("corrupt.db" in f for f in q_files)
    finally:
        recovered_wal.close()


def test_wal_disk_full_error_handling(temp_wal_dir):
    """Simulated SQLite disk-full operational error raises WALCapacityError."""
    db_path = os.path.join(temp_wal_dir, "disk_full.db")
    wal = SQLiteWAL(db_path=db_path)

    real_conn = wal._conn
    class MockConn:
        def __getattr__(self, name):
            return getattr(real_conn, name)
        def execute(self, sql, *args):
            if "INSERT INTO wal_batches" in sql:
                raise sqlite3.OperationalError("database or disk is full")
            return real_conn.execute(sql, *args)

    wal._conn = MockConn()
    try:
        with pytest.raises(WALCapacityError) as exc_info:
            wal.enqueue({"spans": []}, session_name="disk_full_sess")
        assert "disk full" in str(exc_info.value).lower()
    finally:
        wal._conn = real_conn
        wal.close()


def test_wal_subprocess_crash_recovery(temp_wal_dir):
    """A separate Python subprocess commits spans to WAL; parent forcibly terminates it; parent recovers."""
    db_path = os.path.join(temp_wal_dir, "subprocess_crash.db")

    sub_script = f"""
import sys, os, time
from agentdecode import AgentDecode

agent = AgentDecode(
    api_key="al_test",
    endpoint="http://127.0.0.1:9999",  # non-existent endpoint
    wal_path=r"{db_path}",
    timeout=1,
    max_retries=1
)

try:
    with agent.session("crashed_session") as s:
        s.span("unfinished_task")
except Exception:
    pass

# Verify batch is committed to SQLite WAL before signaling parent
stats = agent.wal.get_stats()
if stats["pending_count"] >= 1:
    sys.stdout.write("COMMITTED\\n")
    sys.stdout.flush()

# Keep running indefinitely waiting for forced termination by parent process
while True:
    time.sleep(1)
"""
    script_path = os.path.join(temp_wal_dir, "run_sub.py")
    with open(script_path, "w") as f:
        f.write(sub_script)

    sdk_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = os.environ.copy()
    env["PYTHONPATH"] = sdk_root

    proc = subprocess.Popen(
        [sys.executable, script_path],
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        # Confirm WAL transaction commit from child output
        line = proc.stdout.readline().strip()
        assert line == "COMMITTED", f"Expected COMMITTED, got {line}"

        # Parent forcibly terminates child process (SIGKILL / TerminateProcess)
        proc.kill()
        proc.wait(timeout=5)
        assert proc.returncode != 0
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait()

    # Now in parent process: initialize AgentDecode and recover
    agent = AgentDecode(
        api_key="al_test",
        endpoint="https://example.com",
        wal_path=db_path,
    )
    recovered_count = agent.wal.recover()
    assert recovered_count >= 1
    assert agent.wal.count_pending() == 1
    pending = agent.wal.get_pending()
    assert len(pending) == 1
    assert pending[0].session_name == "crashed_session"
    assert pending[0].payload["spans"][0]["name"] == "unfinished_task"

    # Flush delivering the recovered batch
    delivered = []
    agent.flush(send_fn=lambda p: delivered.append(p))
    assert len(delivered) == 1
    assert agent.wal.count_pending() == 0
    agent.wal.close()


def test_wal_dead_letter_capacity_reached_rejects_without_eviction(temp_wal_dir):
    """Dead-letter store never silently evicts records when capacity is reached, and returns failed batch to pending."""
    db_path = os.path.join(temp_wal_dir, "dl_cap.db")
    wal = SQLiteWAL(db_path=db_path, max_dead_letter_entries=2)

    # Fill dead-letter store to capacity (2 entries)
    b1 = wal.enqueue({"spans": [{"id": "s1"}]}, session_name="s1")
    b2 = wal.enqueue({"spans": [{"id": "s2"}]}, session_name="s2")
    wal.record_permanent_failure(b1, "HTTP 400 Bad Request")
    wal.record_permanent_failure(b2, "HTTP 422 Unprocessable Entity")

    assert wal.count_dead_letter() == 2
    assert wal.count_pending() == 0

    # Enqueue a 3rd batch and transition it to 'sending'
    b3 = wal.enqueue({"spans": [{"id": "s3"}]}, session_name="s3")
    assert wal.count_pending() == 1
    wal.mark_sending([b3])

    # Attempting to move b3 to dead-letter must fail with WALCapacityError
    with pytest.raises(WALCapacityError) as exc_info:
        wal.record_permanent_failure(b3, "HTTP 400 Syntax Error")

    assert "Dead-letter storage limit reached" in str(exc_info.value)

    # Invariants:
    # 1. 0 dead-letter records were evicted
    assert wal.count_dead_letter() == 2
    dl_entries = wal.get_dead_letter()
    dl_ids = {e.id for e in dl_entries}
    assert b1 in dl_ids
    assert b2 in dl_ids

    # 2. b3 is preserved and NOT stranded in 'sending' — returned to 'pending'
    assert wal.count_pending() == 1
    pending = wal.get_pending()
    assert len(pending) == 1
    assert pending[0].id == b3
    assert pending[0].status == "pending"
    assert pending[0].attempts == 1
    assert "Dead-letter storage limit reached" in pending[0].last_error

    # 3. b3 remains retryable and deliverable
    wal.acknowledge(b3)
    assert wal.count_pending() == 0

    wal.close()


def test_wal_get_stats_guarantees_metadata(temp_wal_dir):
    """get_stats accurately exposes platform, capacity, and durability guarantees."""
    db_path = os.path.join(temp_wal_dir, "stats.db")
    wal = SQLiteWAL(db_path=db_path, synchronous_mode="FULL")

    stats = wal.get_stats()
    assert stats["is_durable"] is True
    assert stats["storage_type"] == "sqlite-wal"
    assert stats["synchronous_mode"] == "FULL"
    assert "platform" in stats
    assert "guarantees" in stats
    assert stats["guarantees"]["process_crash_durable"] is True
    if sys.platform == "win32":
        assert stats["guarantees"]["os_crash_durable"] is False
        assert stats["guarantees"]["power_loss_durable"] is False
    else:
        assert stats["guarantees"]["os_crash_durable"] is True
    assert isinstance(stats["guarantees"]["notes"], str)

    wal.close()


def test_wal_concurrent_thread_writes_and_flush(temp_wal_dir):
    """Concurrent threads enqueuing and flushing simultaneously."""
    db_path = os.path.join(temp_wal_dir, "concurrent_stress.db")
    agent = AgentDecode(
        api_key="al_test",
        endpoint="https://example.com",
        wal_path=db_path,
    )

    num_threads = 4
    writes_per_thread = 15
    delivered_count = 0
    lock = threading.Lock()

    def mock_sender(payload):
        nonlocal delivered_count
        with lock:
            delivered_count += 1
            time.sleep(0.005)

    def writer(t_idx):
        for i in range(writes_per_thread):
            agent.wal.enqueue(
                {"t": t_idx, "i": i, "spans": [{"client_span_id": f"s_{t_idx}_{i}"}]},
                session_name=f"th_{t_idx}",
            )
            time.sleep(0.002)

    def flusher():
        for _ in range(10):
            agent.flush(send_fn=mock_sender)
            time.sleep(0.01)

    threads = [threading.Thread(target=writer, args=(t,)) for t in range(num_threads)]
    threads.append(threading.Thread(target=flusher))

    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Final drain
    agent.flush(send_fn=mock_sender)
    assert agent.wal.count_pending() == 0
    assert delivered_count == num_threads * writes_per_thread
    agent.wal.close()


def test_sdk_stable_span_id_on_duplicate_retry(temp_wal_dir):
    """Spans maintain identical client_span_id across retries for server idempotency."""
    db_path = os.path.join(temp_wal_dir, "idempotency.db")
    agent = AgentDecode(
        api_key="test_key",
        endpoint="https://example.com",
        wal_path=db_path,
    )

    attempts = 0
    sent_span_ids = []

    def flaky_send(payload):
        nonlocal attempts
        attempts += 1
        sent_span_ids.append(payload["spans"][0]["client_span_id"])
        if attempts == 1:
            raise ConnectionError("Simulated drop on first attempt")
        return {"status": "ok"}

    with agent.session("idempotent_session", _send_fn=flaky_send) as s:
        s.span("unique_operation")

    # First attempt failed, batch still in WAL
    assert agent.wal.count_pending() == 1
    assert len(sent_span_ids) == 1

    # Retry via flush
    agent.flush(send_fn=flaky_send)
    assert len(sent_span_ids) == 2
    # Verify that both attempts sent the EXACT same client_span_id
    assert sent_span_ids[0] == sent_span_ids[1]

    # Batch successfully acknowledged on 2nd attempt
    assert agent.wal.count_pending() == 0
    agent.wal.close()
