"""
SQLite-backed Persistent Write-Ahead Log (WAL) for AgentDecode Python SDK.

Provides durable, crash-resilient at-least-once delivery guarantees across
process crashes, restarts, and machine reboots using Python standard library sqlite3.
"""

from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import threading
import time
import uuid
from dataclasses import dataclass
from typing import Any, Dict, List, Optional


class WALError(Exception):
    """Base exception for WAL errors."""


class WALCapacityError(WALError):
    """Raised when WAL has reached maximum storage capacity without evicting pending records."""


class WALStorageError(WALError):
    """Raised on underlying SQLite I/O, lock, or disk errors."""


class WALCorruptedError(WALError):
    """Raised or notified when database corruption is detected."""


@dataclass
class WALBatch:
    """A persisted batch of spans awaiting transmission."""
    id: str
    session_name: str
    session_id: Optional[str]
    payload: Dict[str, Any]
    created_at: float
    attempts: int
    last_error: Optional[str] = None
    status: str = "pending"


@dataclass
class DeadLetterBatch:
    """A batch that permanently failed delivery (HTTP 4xx non-429)."""
    id: str
    session_name: str
    session_id: Optional[str]
    payload: Dict[str, Any]
    created_at: float
    attempts: int
    error_message: str
    failed_at: float


class SQLiteWAL:
    """Thread-safe, crash-resilient SQLite write-ahead log.

    Durability properties:
    - Default PRAGMA synchronous = FULL provides durable commits to disk.
    - PRAGMA journal_mode = WAL ensures atomic log commits and concurrent read/write.
    - Effective PRAGMAs are verified on every connection.
    - Transactions ensure entries are completely written before returning success.
    - Unsafe FIFO eviction is eliminated: capacity limits preserve existing pending data
      and raise explicit WALCapacityError.
    """

    DEFAULT_WAL_PATH = os.path.join(
        os.path.expanduser("~"), ".agentdecode", "wal.db"
    )

    def __init__(
        self,
        db_path: Optional[str] = None,
        max_entries: int = 10000,
        max_bytes: int = 50 * 1024 * 1024,  # 50 MB
        synchronous_mode: str = "FULL",
        max_dead_letter_entries: int = 2000,
    ) -> None:
        self.db_path = db_path or os.environ.get(
            "AGENTDECODE_WAL_PATH", self.DEFAULT_WAL_PATH
        )
        self.max_entries = max_entries
        self.max_bytes = max_bytes
        self.synchronous_mode = synchronous_mode.upper()
        self.max_dead_letter_entries = max_dead_letter_entries
        self._lock = threading.RLock()
        self._is_closed = False
        self._conn: Optional[sqlite3.Connection] = None
        self.quarantined_paths: List[str] = []

        self._init_db()

    def _open_connection(self) -> sqlite3.Connection:
        """Create a connection and verify required durability pragmas."""
        if self.db_path != ":memory:":
            parent_dir = os.path.dirname(os.path.abspath(self.db_path))
            os.makedirs(parent_dir, exist_ok=True)

        conn = sqlite3.connect(
            self.db_path,
            timeout=10.0,
            check_same_thread=False,
            isolation_level=None,  # Autocommit mode, manual BEGIN/COMMIT
        )
        try:
            conn.row_factory = sqlite3.Row
            if self.db_path != ":memory:":
                conn.execute("PRAGMA journal_mode = WAL;")
                conn.execute(f"PRAGMA synchronous = {self.synchronous_mode};")

            conn.execute("PRAGMA busy_timeout = 5000;")

            # ── Verify effective PRAGMA settings ──────────────────────────
            if self.db_path != ":memory:":
                cur = conn.execute("PRAGMA journal_mode;")
                row = cur.fetchone()
                effective_journal = row[0].lower() if row else ""
                if effective_journal != "wal":
                    raise WALStorageError(
                        f"Failed to set WAL journal mode. Effective: {effective_journal}"
                    )

                cur = conn.execute("PRAGMA synchronous;")
                row = cur.fetchone()
                effective_sync = row[0] if row else 0
                expected_sync = 2 if self.synchronous_mode == "FULL" else 1
                if effective_sync != expected_sync:
                    raise WALStorageError(
                        f"PRAGMA synchronous mismatch. Expected {expected_sync}, got {effective_sync}"
                    )

            cur = conn.execute("PRAGMA busy_timeout;")
            row = cur.fetchone()
            effective_timeout = row[0] if row else 0
            if effective_timeout < 5000:
                raise WALStorageError(
                    f"PRAGMA busy_timeout mismatch. Expected >= 5000, got {effective_timeout}"
                )

            return conn
        except Exception:
            try:
                conn.close()
            except Exception:
                pass
            raise

    def _ensure_conn(self) -> sqlite3.Connection:
        if self._conn is None:
            self._conn = self._open_connection()
        return self._conn

    def _init_db(self) -> None:
        """Initialize database schema, handling corruption quarantine if needed."""
        with self._lock:
            try:
                conn = self._ensure_conn()
                try:
                    conn.execute("BEGIN IMMEDIATE;")
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS wal_batches (
                            id TEXT PRIMARY KEY,
                            session_name TEXT NOT NULL,
                            session_id TEXT,
                            payload_json TEXT NOT NULL,
                            created_at REAL NOT NULL,
                            attempts INTEGER NOT NULL DEFAULT 0,
                            last_error TEXT,
                            status TEXT NOT NULL DEFAULT 'pending'
                        );
                    """)
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS dead_letter_batches (
                            id TEXT PRIMARY KEY,
                            session_name TEXT NOT NULL,
                            session_id TEXT,
                            payload_json TEXT NOT NULL,
                            created_at REAL NOT NULL,
                            attempts INTEGER NOT NULL,
                            error_message TEXT NOT NULL,
                            failed_at REAL NOT NULL
                        );
                    """)
                    conn.execute("""
                        CREATE INDEX IF NOT EXISTS idx_wal_status_created
                        ON wal_batches(status, created_at);
                    """)
                    conn.execute("COMMIT;")
                except Exception:
                    conn.execute("ROLLBACK;")
                    raise
            except sqlite3.DatabaseError as e:
                self._handle_corruption(e)

    def _handle_corruption(self, error: Exception) -> None:
        """Quarantine corrupted database and sidecars together, then start a fresh WAL."""
        quarantine_dir = f"{self.db_path}.quarantine_{int(time.time() * 1000)}"
        print(
            f"[agentdecode] CRITICAL: WAL database corrupted ({error}). "
            f"Preserving corrupted file and sidecars in quarantine directory: {quarantine_dir}",
            file=sys.stderr,
        )

        if self._conn:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None

        if self.db_path != ":memory:":
            try:
                os.makedirs(quarantine_dir, exist_ok=True)
                for ext in ("", "-wal", "-shm"):
                    file_path = f"{self.db_path}{ext}"
                    if os.path.exists(file_path):
                        target_path = os.path.join(quarantine_dir, os.path.basename(file_path))
                        try:
                            shutil.move(file_path, target_path)
                        except Exception as move_err:
                            print(f"[agentdecode] Failed to move {file_path} to quarantine: {move_err}", file=sys.stderr)
                self.quarantined_paths.append(quarantine_dir)
            except Exception as q_err:
                print(f"[agentdecode] Failed to create quarantine directory: {q_err}", file=sys.stderr)

        # Re-initialize clean DB
        conn = self._ensure_conn()
        conn.execute("BEGIN IMMEDIATE;")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS wal_batches (
                id TEXT PRIMARY KEY,
                session_name TEXT NOT NULL,
                session_id TEXT,
                payload_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                status TEXT NOT NULL DEFAULT 'pending'
            );
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS dead_letter_batches (
                id TEXT PRIMARY KEY,
                session_name TEXT NOT NULL,
                session_id TEXT,
                payload_json TEXT NOT NULL,
                created_at REAL NOT NULL,
                attempts INTEGER NOT NULL,
                error_message TEXT NOT NULL,
                failed_at REAL NOT NULL
            );
        """)
        conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_wal_status_created
            ON wal_batches(status, created_at);
        """)
        conn.execute("COMMIT;")

    def recover(self) -> int:
        """Recover pending batches from previous crashes.

        Resets any batches left in 'sending' state back to 'pending'.
        Returns count of pending batches.
        """
        with self._lock:
            conn = self._ensure_conn()
            try:
                conn.execute("BEGIN IMMEDIATE;")
                conn.execute("""
                    UPDATE wal_batches
                    SET status = 'pending'
                    WHERE status = 'sending';
                """)
                cur = conn.execute(
                    "SELECT COUNT(*) as cnt FROM wal_batches WHERE status = 'pending';"
                )
                row = cur.fetchone()
                count = row["cnt"] if row else 0
                conn.execute("COMMIT;")
                return count
            except Exception as e:
                conn.execute("ROLLBACK;")
                raise WALStorageError(f"Failed to recover WAL batches: {e}") from e

    def enqueue(
        self,
        payload: Dict[str, Any],
        session_name: str,
        session_id: Optional[str] = None,
    ) -> str:
        """Persist a batch of spans to disk before attempting delivery.

        Guarantees that the batch is committed to SQLite WAL before returning.
        Refuses new entries with WALCapacityError if storage limits are reached;
        existing unacknowledged batches are NEVER deleted to make space.
        """
        batch_id = str(uuid.uuid4())
        payload_json = json.dumps(payload, default=str)
        now = time.time()

        with self._lock:
            conn = self._ensure_conn()
            try:
                conn.execute("BEGIN IMMEDIATE;")

                # Enforce storage limits: never silently evict existing records!
                self._check_capacity(conn, len(payload_json))

                conn.execute("""
                    INSERT INTO wal_batches (
                        id, session_name, session_id, payload_json, created_at, attempts, status
                    ) VALUES (?, ?, ?, ?, ?, 0, 'pending');
                """, (batch_id, session_name, session_id, payload_json, now))

                conn.execute("COMMIT;")
                return batch_id
            except (WALCapacityError, WALStorageError):
                conn.execute("ROLLBACK;")
                raise
            except sqlite3.OperationalError as e:
                conn.execute("ROLLBACK;")
                if "disk is full" in str(e).lower() or "no space" in str(e).lower():
                    raise WALCapacityError(f"SQLite disk full: {e}") from e
                raise WALStorageError(f"SQLite operational error during enqueue: {e}") from e
            except Exception as e:
                conn.execute("ROLLBACK;")
                raise WALStorageError(f"Unexpected error during WAL enqueue: {e}") from e

    def _check_capacity(self, conn: sqlite3.Connection, new_bytes: int) -> None:
        """Check capacity and raise WALCapacityError if limits are reached.

        Zero eviction of unacknowledged data.
        """
        cur = conn.execute("SELECT COUNT(*) as cnt FROM wal_batches;")
        cnt = cur.fetchone()["cnt"]
        if cnt >= self.max_entries:
            raise WALCapacityError(
                f"WAL capacity limit reached ({cnt}/{self.max_entries} batches). "
                f"Existing pending batches preserved; refusing new enqueue."
            )

        if self.max_bytes > 0 and self.db_path != ":memory:" and os.path.exists(self.db_path):
            current_size = os.path.getsize(self.db_path)
            if (current_size + new_bytes) > self.max_bytes:
                raise WALCapacityError(
                    f"WAL maximum byte limit reached ({current_size}/{self.max_bytes} bytes). "
                    f"Existing pending batches preserved; refusing new enqueue."
                )

    def get_pending(self, limit: int = 50) -> List[WALBatch]:
        """Fetch pending batches ready for delivery."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                cur = conn.execute("""
                    SELECT id, session_name, session_id, payload_json, created_at, attempts, last_error, status
                    FROM wal_batches
                    WHERE status = 'pending'
                    ORDER BY created_at ASC
                    LIMIT ?;
                """, (limit,))
                batches = []
                for row in cur.fetchall():
                    batches.append(WALBatch(
                        id=row["id"],
                        session_name=row["session_name"],
                        session_id=row["session_id"],
                        payload=json.loads(row["payload_json"]),
                        created_at=row["created_at"],
                        attempts=row["attempts"],
                        last_error=row["last_error"],
                        status=row["status"],
                    ))
                return batches
            except Exception as e:
                raise WALStorageError(f"Failed to fetch pending WAL batches: {e}") from e

    def mark_sending(self, batch_ids: List[str]) -> None:
        """Mark batches as actively in-flight."""
        if not batch_ids:
            return
        with self._lock:
            conn = self._ensure_conn()
            try:
                conn.execute("BEGIN IMMEDIATE;")
                placeholders = ",".join("?" for _ in batch_ids)
                conn.execute(
                    f"UPDATE wal_batches SET status = 'sending' WHERE id IN ({placeholders});",
                    batch_ids,
                )
                conn.execute("COMMIT;")
            except Exception as e:
                conn.execute("ROLLBACK;")
                raise WALStorageError(f"Failed to mark batches as sending: {e}") from e

    def acknowledge(self, batch_id: str) -> None:
        """Delete batch from WAL only after confirmed successful delivery (HTTP 200)."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                conn.execute("BEGIN IMMEDIATE;")
                conn.execute("DELETE FROM wal_batches WHERE id = ?;", (batch_id,))
                conn.execute("COMMIT;")
            except Exception as e:
                conn.execute("ROLLBACK;")
                raise WALStorageError(f"Failed to acknowledge batch {batch_id}: {e}") from e

    def record_retry(self, batch_id: str, error_message: str) -> None:
        """Reset batch to pending and increment attempt counter on transient network failure."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                conn.execute("BEGIN IMMEDIATE;")
                conn.execute("""
                    UPDATE wal_batches
                    SET status = 'pending',
                        attempts = attempts + 1,
                        last_error = ?
                    WHERE id = ?;
                """, (error_message, batch_id))
                conn.execute("COMMIT;")
            except Exception as e:
                conn.execute("ROLLBACK;")
                raise WALStorageError(f"Failed to record retry for batch {batch_id}: {e}") from e

    def record_permanent_failure(self, batch_id: str, error_message: str) -> None:
        """Move batch to dead-letter storage when a permanent non-retryable 4xx client error occurs.

        Guarantees:
        - Never silently evicts existing dead-letter records.
        - If dead-letter capacity limit is reached:
          - Preserves all existing dead-letter records.
          - Reverts batch status to 'pending' (never leaves it stranded in 'sending').
          - Increments attempts and records last_error so it remains retryable.
          - Surfaces explicit WALCapacityError.
        """
        with self._lock:
            conn = self._ensure_conn()
            capacity_error: Optional[WALCapacityError] = None
            try:
                conn.execute("BEGIN IMMEDIATE;")
                cur = conn.execute("SELECT * FROM wal_batches WHERE id = ?;", (batch_id,))
                row = cur.fetchone()
                if row:
                    # Enforce bounded dead-letter storage without silent eviction
                    dl_cur = conn.execute("SELECT COUNT(*) as cnt FROM dead_letter_batches;")
                    dl_cnt = dl_cur.fetchone()["cnt"]
                    if dl_cnt >= self.max_dead_letter_entries:
                        conn.execute("""
                            UPDATE wal_batches
                            SET status = 'pending',
                                attempts = attempts + 1,
                                last_error = ?
                            WHERE id = ?;
                        """, (f"Dead-letter storage limit reached ({dl_cnt}/{self.max_dead_letter_entries}). Error: {error_message}", batch_id))
                        conn.execute("COMMIT;")
                        capacity_error = WALCapacityError(
                            f"Dead-letter storage limit reached ({dl_cnt}/{self.max_dead_letter_entries}). "
                            f"Preserving original batch {batch_id} in active queue with status 'pending'; refusing dead-letter archive."
                        )
                    else:
                        conn.execute("""
                            INSERT INTO dead_letter_batches (
                                id, session_name, session_id, payload_json, created_at, attempts, error_message, failed_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                        """, (
                            row["id"], row["session_name"], row["session_id"],
                            row["payload_json"], row["created_at"],
                            row["attempts"] + 1, error_message, time.time()
                        ))
                        conn.execute("DELETE FROM wal_batches WHERE id = ?;", (batch_id,))
                        print(
                            f"[agentdecode] Permanent telemetry ingestion error for batch {batch_id}: {error_message}. "
                            f"Archived in dead_letter_batches table.",
                            file=sys.stderr,
                        )
                        conn.execute("COMMIT;")
            except Exception as e:
                conn.execute("ROLLBACK;")
                raise WALStorageError(f"Failed to record permanent failure for batch {batch_id}: {e}") from e

            if capacity_error is not None:
                raise capacity_error

    def get_dead_letter(self, limit: int = 50) -> List[DeadLetterBatch]:
        """Inspect archived dead-letter batches."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                cur = conn.execute("""
                    SELECT id, session_name, session_id, payload_json, created_at, attempts, error_message, failed_at
                    FROM dead_letter_batches
                    ORDER BY failed_at DESC
                    LIMIT ?;
                """, (limit,))
                entries = []
                for row in cur.fetchall():
                    entries.append(DeadLetterBatch(
                        id=row["id"],
                        session_name=row["session_name"],
                        session_id=row["session_id"],
                        payload=json.loads(row["payload_json"]),
                        created_at=row["created_at"],
                        attempts=row["attempts"],
                        error_message=row["error_message"],
                        failed_at=row["failed_at"],
                    ))
                return entries
            except Exception as e:
                raise WALStorageError(f"Failed to fetch dead-letter entries: {e}") from e

    def requeue_dead_letter(self, batch_ids: Optional[List[str]] = None) -> int:
        """Re-queue dead-letter batches back to active pending queue for retry."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                conn.execute("BEGIN IMMEDIATE;")
                if batch_ids:
                    placeholders = ",".join("?" for _ in batch_ids)
                    cur = conn.execute(
                        f"SELECT * FROM dead_letter_batches WHERE id IN ({placeholders});",
                        batch_ids,
                    )
                else:
                    cur = conn.execute("SELECT * FROM dead_letter_batches;")

                rows = cur.fetchall()
                requeued = 0
                for row in rows:
                    conn.execute("""
                        INSERT OR REPLACE INTO wal_batches (
                            id, session_name, session_id, payload_json, created_at, attempts, status
                        ) VALUES (?, ?, ?, ?, ?, 0, 'pending');
                    """, (
                        row["id"], row["session_name"], row["session_id"],
                        row["payload_json"], row["created_at"]
                    ))
                    conn.execute("DELETE FROM dead_letter_batches WHERE id = ?;", (row["id"],))
                    requeued += 1

                conn.execute("COMMIT;")
                return requeued
            except Exception as e:
                conn.execute("ROLLBACK;")
                raise WALStorageError(f"Failed to requeue dead-letter batches: {e}") from e

    def purge_dead_letter(self, before_failed_at: Optional[float] = None) -> int:
        """Purge dead-letter batches, optionally older than a timestamp."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                conn.execute("BEGIN IMMEDIATE;")
                if before_failed_at is not None:
                    cur = conn.execute(
                        "DELETE FROM dead_letter_batches WHERE failed_at < ?;",
                        (before_failed_at,),
                    )
                else:
                    cur = conn.execute("DELETE FROM dead_letter_batches;")
                deleted = cur.rowcount
                conn.execute("COMMIT;")
                return deleted
            except Exception as e:
                conn.execute("ROLLBACK;")
                raise WALStorageError(f"Failed to purge dead-letter batches: {e}") from e

    def get_stats(self) -> Dict[str, Any]:
        """Return comprehensive queue usage, capacity, and durability metrics."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                cur = conn.execute("SELECT status, COUNT(*) as cnt FROM wal_batches GROUP BY status;")
                counts = {row["status"]: row["cnt"] for row in cur.fetchall()}
                dead_cnt = self.count_dead_letter()
                file_size = (
                    os.path.getsize(self.db_path)
                    if self.db_path != ":memory:" and os.path.exists(self.db_path)
                    else 0
                )
                is_mem = self.db_path == ":memory:"
                return {
                    "pending_count": counts.get("pending", 0),
                    "sending_count": counts.get("sending", 0),
                    "total_active_count": sum(counts.values()),
                    "dead_letter_count": dead_cnt,
                    "max_entries": self.max_entries,
                    "max_bytes": self.max_bytes,
                    "max_dead_letter_entries": self.max_dead_letter_entries,
                    "db_size_bytes": file_size,
                    "is_durable": not is_mem,
                    "storage_type": "sqlite-wal" if not is_mem else "sqlite-memory",
                    "synchronous_mode": self.synchronous_mode,
                    "platform": sys.platform,
                    "guarantees": {
                        "process_crash_durable": not is_mem,
                        "os_crash_durable": not is_mem and sys.platform != "win32",
                        "power_loss_durable": False,
                        "notes": (
                            "In-memory SQLite is volatile and loses all records on process termination."
                            if is_mem
                            else "Windows NTFS: Process-restart durability is verified via SQLite WAL. OS-crash durability is not guaranteed (osCrashDurable=false) due to Windows directory-entry metadata flushing limitations. Power-loss durability is not guaranteed without enterprise PLP disk cache."
                            if sys.platform == "win32"
                            else "POSIX: Full process and OS crash durability guaranteed via SQLite WAL with PRAGMA synchronous=FULL."
                        ),
                    },
                    "has_quarantined_data": len(self.quarantined_paths) > 0,
                    "quarantined_paths": list(self.quarantined_paths),
                }
            except Exception as e:
                raise WALStorageError(f"Failed to get WAL stats: {e}") from e

    def count_pending(self) -> int:
        """Return total count of pending and in-flight batches."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                cur = conn.execute("SELECT COUNT(*) as cnt FROM wal_batches;")
                return cur.fetchone()["cnt"]
            except Exception as e:
                raise WALStorageError(f"Failed to count pending batches: {e}") from e

    def count_dead_letter(self) -> int:
        """Return total count of dead-letter batches."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                cur = conn.execute("SELECT COUNT(*) as cnt FROM dead_letter_batches;")
                return cur.fetchone()["cnt"]
            except Exception as e:
                raise WALStorageError(f"Failed to count dead-letter batches: {e}") from e

    def clear(self) -> None:
        """Clear all records (used for test isolation)."""
        with self._lock:
            conn = self._ensure_conn()
            try:
                conn.execute("BEGIN IMMEDIATE;")
                conn.execute("DELETE FROM wal_batches;")
                conn.execute("DELETE FROM dead_letter_batches;")
                conn.execute("COMMIT;")
            except Exception as e:
                conn.execute("ROLLBACK;")
                raise WALStorageError(f"Failed to clear WAL: {e}") from e

    def close(self) -> None:
        with self._lock:
            self._is_closed = True
            if self._conn:
                try:
                    self._conn.close()
                except Exception:
                    pass
                self._conn = None
