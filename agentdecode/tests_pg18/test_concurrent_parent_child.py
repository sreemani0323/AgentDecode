"""
Genuinely Concurrent Parent/Child Arrival Integration Test
Uses separate PostgreSQL TCP connections to test concurrent arrival,
mutual exclusion advisory locking, and pending parent resolution.
Target: PostgreSQL 18.6 on port 5433
"""

import sys
import uuid
import time
import threading
import psycopg2
from psycopg2.extras import RealDictCursor

PG_CONFIG = {
    "host": "127.0.0.1",
    "port": 5433,
    "dbname": "postgres",
    "user": "postgres",
}

def get_connection():
    conn = psycopg2.connect(**PG_CONFIG)
    conn.autocommit = True
    return conn

def setup_test_environment():
    conn = get_connection()
    with conn.cursor() as cur:
        org_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO public.organizations (id, name, slug) VALUES (%s, %s, %s)",
            (org_id, "Concurrency Test Org", f"concurrency-org-{uuid.uuid4().hex[:8]}")
        )
        proj_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO public.projects (id, org_id, name) VALUES (%s, %s, %s)",
            (proj_id, org_id, "Concurrency Test Project")
        )
        sess_id = str(uuid.uuid4())
        cur.execute(
            "INSERT INTO public.sessions (id, project_id, name, started_at) VALUES (%s, %s, %s, now())",
            (sess_id, proj_id, "Concurrency Test Session")
        )
    conn.close()
    return proj_id, sess_id

def test_simultaneous_parent_child_barrier(proj_id, sess_id, iterations=30):
    print(f"\n--- Suite A: Exact Simultaneous Parent/Child Arrival (Barrier, {iterations} iterations) ---")
    conn_verify = get_connection()

    for i in range(iterations):
        trace_id = uuid.uuid4().hex
        parent_span_id = uuid.uuid4().hex[:16]
        child_span_id = uuid.uuid4().hex[:16]

        barrier = threading.Barrier(2)
        results = {}
        errors = []

        def worker_child():
            conn = get_connection()
            try:
                barrier.wait(timeout=5)
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("""
                        SELECT * FROM public.ingest_span_transactional(
                            p_project_id := %s,
                            p_session_id := %s,
                            p_trace_id := %s,
                            p_span_id := %s,
                            p_parent_span_id_hex := %s,
                            p_name := 'child_span',
                            p_span_type := 'tool',
                            p_started_at := now()
                        )
                    """, (proj_id, sess_id, trace_id, child_span_id, parent_span_id))
                    results['child'] = cur.fetchone()
            except Exception as e:
                errors.append(('child', e))
            finally:
                conn.close()

        def worker_parent():
            conn = get_connection()
            try:
                barrier.wait(timeout=5)
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("""
                        SELECT * FROM public.ingest_span_transactional(
                            p_project_id := %s,
                            p_session_id := %s,
                            p_trace_id := %s,
                            p_span_id := %s,
                            p_name := 'parent_span',
                            p_span_type := 'chain',
                            p_started_at := now()
                        )
                    """, (proj_id, sess_id, trace_id, parent_span_id))
                    results['parent'] = cur.fetchone()
            except Exception as e:
                errors.append(('parent', e))
            finally:
                conn.close()

        t1 = threading.Thread(target=worker_child)
        t2 = threading.Thread(target=worker_parent)

        t1.start()
        t2.start()
        t1.join(timeout=10)
        t2.join(timeout=10)

        assert not errors, f"Iteration {i}: Worker thread error: {errors}"
        assert 'child' in results and 'parent' in results, f"Iteration {i}: Incomplete results"

        child_db_id = results['child']['out_db_id']
        parent_db_id = results['parent']['out_db_id']

        # Verify database state after both transactions commit
        with conn_verify.cursor(cursor_factory=RealDictCursor) as cur:
            # 1. Child parent_span_id must equal parent_db_id
            cur.execute("SELECT parent_span_id FROM public.spans WHERE id = %s", (child_db_id,))
            child_row = cur.fetchone()
            assert child_row is not None, f"Child span {child_db_id} not found in spans"
            assert str(child_row['parent_span_id']) == str(parent_db_id), (
                f"Iteration {i}: Child parent_span_id mismatch! Expected {parent_db_id}, got {child_row['parent_span_id']}"
            )

            # 2. Pending resolutions must be 0
            cur.execute("""
                SELECT count(*) as cnt FROM public.pending_parent_resolutions
                WHERE project_id = %s AND trace_id = %s AND parent_span_id_hex = %s
            """, (proj_id, trace_id, parent_span_id))
            pending_cnt = cur.fetchone()['cnt']
            assert pending_cnt == 0, f"Iteration {i}: Pending parent resolution not cleaned up! Count = {pending_cnt}"

    conn_verify.close()
    print(f"PASSED: {iterations} simultaneous concurrent iterations verified with 0 dropped/missed links.")

def test_child_strictly_before_parent(proj_id, sess_id, iterations=15):
    print(f"\n--- Suite B: Child Arrives First, Parent Arrives Second ({iterations} iterations) ---")
    conn_verify = get_connection()

    for i in range(iterations):
        trace_id = uuid.uuid4().hex
        parent_span_id = uuid.uuid4().hex[:16]
        child_span_id = uuid.uuid4().hex[:16]

        conn_child = get_connection()
        conn_parent = get_connection()

        try:
            # 1. Child arrives first on conn_child
            with conn_child.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT * FROM public.ingest_span_transactional(
                        p_project_id := %s,
                        p_session_id := %s,
                        p_trace_id := %s,
                        p_span_id := %s,
                        p_parent_span_id_hex := %s,
                        p_name := 'child_first',
                        p_span_type := 'tool',
                        p_started_at := now()
                    )
                """, (proj_id, sess_id, trace_id, child_span_id, parent_span_id))
                child_res = cur.fetchone()

            assert child_res['out_is_parent_pending'] is True, "Child should report parent pending"

            # Check that pending table has 1 record
            with conn_verify.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT count(*) as cnt FROM public.pending_parent_resolutions
                    WHERE project_id = %s AND trace_id = %s AND parent_span_id_hex = %s
                """, (proj_id, trace_id, parent_span_id))
                assert cur.fetchone()['cnt'] == 1, "Pending parent resolution not recorded"

            # 2. Parent arrives second on conn_parent
            with conn_parent.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT * FROM public.ingest_span_transactional(
                        p_project_id := %s,
                        p_session_id := %s,
                        p_trace_id := %s,
                        p_span_id := %s,
                        p_name := 'parent_second',
                        p_span_type := 'chain',
                        p_started_at := now()
                    )
                """, (proj_id, sess_id, trace_id, parent_span_id))
                parent_res = cur.fetchone()

            # Verify resolution in DB
            with conn_verify.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT parent_span_id FROM public.spans WHERE id = %s", (child_res['out_db_id'],))
                child_row = cur.fetchone()
                assert str(child_row['parent_span_id']) == str(parent_res['out_db_id']), (
                    f"Child parent_span_id was not resolved to parent! Got {child_row['parent_span_id']}"
                )

                cur.execute("""
                    SELECT count(*) as cnt FROM public.pending_parent_resolutions
                    WHERE project_id = %s AND trace_id = %s AND parent_span_id_hex = %s
                """, (proj_id, trace_id, parent_span_id))
                assert cur.fetchone()['cnt'] == 0, "Pending table should be empty after parent arrives"

        finally:
            conn_child.close()
            conn_parent.close()

    conn_verify.close()
    print(f"PASSED: {iterations} out-of-order iterations verified cleanly.")

def test_parent_strictly_before_child(proj_id, sess_id, iterations=15):
    print(f"\n--- Suite C: Parent Arrives First, Child Arrives Second ({iterations} iterations) ---")
    conn_verify = get_connection()

    for i in range(iterations):
        trace_id = uuid.uuid4().hex
        parent_span_id = uuid.uuid4().hex[:16]
        child_span_id = uuid.uuid4().hex[:16]

        conn_parent = get_connection()
        conn_child = get_connection()

        try:
            # 1. Parent arrives first on conn_parent
            with conn_parent.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT * FROM public.ingest_span_transactional(
                        p_project_id := %s,
                        p_session_id := %s,
                        p_trace_id := %s,
                        p_span_id := %s,
                        p_name := 'parent_first',
                        p_span_type := 'chain',
                        p_started_at := now()
                    )
                """, (proj_id, sess_id, trace_id, parent_span_id))
                parent_res = cur.fetchone()

            # 2. Child arrives second on conn_child
            with conn_child.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("""
                    SELECT * FROM public.ingest_span_transactional(
                        p_project_id := %s,
                        p_session_id := %s,
                        p_trace_id := %s,
                        p_span_id := %s,
                        p_parent_span_id_hex := %s,
                        p_name := 'child_second',
                        p_span_type := 'tool',
                        p_started_at := now()
                    )
                """, (proj_id, sess_id, trace_id, child_span_id, parent_span_id))
                child_res = cur.fetchone()

            assert child_res['out_is_parent_pending'] is False, "Child should immediately resolve parent"
            assert str(child_res['out_resolved_parent_id']) == str(parent_res['out_db_id']), "Immediate parent resolution mismatch"

            # Check DB
            with conn_verify.cursor(cursor_factory=RealDictCursor) as cur:
                cur.execute("SELECT parent_span_id FROM public.spans WHERE id = %s", (child_res['out_db_id'],))
                child_row = cur.fetchone()
                assert str(child_row['parent_span_id']) == str(parent_res['out_db_id']), "Child parent_span_id mismatch in spans"

                cur.execute("""
                    SELECT count(*) as cnt FROM public.pending_parent_resolutions
                    WHERE project_id = %s AND trace_id = %s AND parent_span_id_hex = %s
                """, (proj_id, trace_id, parent_span_id))
                assert cur.fetchone()['cnt'] == 0, "No pending parent resolution should exist"

        finally:
            conn_parent.close()
            conn_child.close()

    conn_verify.close()
    print(f"PASSED: {iterations} in-order iterations verified cleanly.")

def test_multi_child_concurrent_fan_out(proj_id, sess_id, num_children=5, iterations=10):
    print(f"\n--- Suite D: 1 Parent + {num_children} Concurrent Children on Separate Connections ({iterations} iterations) ---")
    conn_verify = get_connection()

    for it in range(iterations):
        trace_id = uuid.uuid4().hex
        parent_span_id = uuid.uuid4().hex[:16]
        child_span_ids = [uuid.uuid4().hex[:16] for _ in range(num_children)]

        barrier = threading.Barrier(num_children + 1)
        results = {}
        errors = []

        def child_task(c_id):
            conn = get_connection()
            try:
                barrier.wait(timeout=5)
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("""
                        SELECT * FROM public.ingest_span_transactional(
                            p_project_id := %s,
                            p_session_id := %s,
                            p_trace_id := %s,
                            p_span_id := %s,
                            p_parent_span_id_hex := %s,
                            p_name := 'fanout_child',
                            p_span_type := 'tool',
                            p_started_at := now()
                        )
                    """, (proj_id, sess_id, trace_id, c_id, parent_span_id))
                    results[c_id] = cur.fetchone()
            except Exception as e:
                errors.append((c_id, e))
            finally:
                conn.close()

        def parent_task():
            conn = get_connection()
            try:
                barrier.wait(timeout=5)
                # Small microsecond sleep to ensure interleaving
                time.sleep(0.002)
                with conn.cursor(cursor_factory=RealDictCursor) as cur:
                    cur.execute("""
                        SELECT * FROM public.ingest_span_transactional(
                            p_project_id := %s,
                            p_session_id := %s,
                            p_trace_id := %s,
                            p_span_id := %s,
                            p_name := 'fanout_parent',
                            p_span_type := 'chain',
                            p_started_at := now()
                        )
                    """, (proj_id, sess_id, trace_id, parent_span_id))
                    results['parent'] = cur.fetchone()
            except Exception as e:
                errors.append(('parent', e))
            finally:
                conn.close()

        threads = [threading.Thread(target=child_task, args=(c_id,)) for c_id in child_span_ids]
        threads.append(threading.Thread(target=parent_task))

        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        assert not errors, f"Iteration {it}: Worker errors: {errors}"
        parent_db_id = results['parent']['out_db_id']

        with conn_verify.cursor(cursor_factory=RealDictCursor) as cur:
            # Check all children
            for c_id in child_span_ids:
                child_db_id = results[c_id]['out_db_id']
                cur.execute("SELECT parent_span_id FROM public.spans WHERE id = %s", (child_db_id,))
                c_row = cur.fetchone()
                assert str(c_row['parent_span_id']) == str(parent_db_id), (
                    f"Child {c_id} parent mismatch: got {c_row['parent_span_id']}, expected {parent_db_id}"
                )

            # Pending table check
            cur.execute("""
                SELECT count(*) as cnt FROM public.pending_parent_resolutions
                WHERE project_id = %s AND trace_id = %s AND parent_span_id_hex = %s
            """, (proj_id, trace_id, parent_span_id))
            assert cur.fetchone()['cnt'] == 0, f"Pending resolutions lingering: {cur.fetchone()['cnt']}"

    conn_verify.close()
    print(f"PASSED: {iterations} fan-out iterations with {num_children} concurrent child connections each verified.")

if __name__ == '__main__':
    print("Connecting to PostgreSQL 18.6 on port 5433...")
    proj_id, sess_id = setup_test_environment()
    print(f"Environment ready: Project {proj_id}, Session {sess_id}")

    test_simultaneous_parent_child_barrier(proj_id, sess_id, iterations=30)
    test_child_strictly_before_parent(proj_id, sess_id, iterations=15)
    test_parent_strictly_before_child(proj_id, sess_id, iterations=15)
    test_multi_child_concurrent_fan_out(proj_id, sess_id, num_children=5, iterations=10)

    print("\n=======================================================")
    print("ALL GENUINELY CONCURRENT INTEGRATION TESTS PASSED (100%)")
    print("=======================================================")
