"""Unit tests for the AgentDecode Python SDK.

All tests use an injectable _send_fn to capture payloads without
hitting the network.
"""

import json
import sys
import unittest
from datetime import datetime, timezone

# Ensure the local package is importable
sys.path.insert(0, ".")

from agentdecode import AgentDecode, Session, Span


class TestSpan(unittest.TestCase):
    """Span object tests."""

    def test_span_basic_fields(self):
        with Span("test_op", span_type="llm") as span:
            span.model = "gpt-4o"
            span.input = {"prompt": "hi"}
            span.output = {"text": "hello"}
            span.input_tokens = 10
            span.output_tokens = 5
            span.cost_usd = 0.001
            span.metadata = {"env": "test"}

        d = span.to_dict()
        self.assertEqual(d["name"], "test_op")
        self.assertEqual(d["span_type"], "llm")
        self.assertEqual(d["status"], "ok")
        self.assertEqual(d["model"], "gpt-4o")
        self.assertEqual(d["input"], {"prompt": "hi"})
        self.assertEqual(d["output"], {"text": "hello"})
        self.assertEqual(d["input_tokens"], 10)
        self.assertEqual(d["output_tokens"], 5)
        self.assertAlmostEqual(d["cost_usd"], 0.001)
        self.assertEqual(d["metadata"], {"env": "test"})
        self.assertIn("started_at", d)
        self.assertIn("ended_at", d)
        self.assertIn("client_span_id", d)
        self.assertIsInstance(d["duration_ms"], int)
        self.assertGreaterEqual(d["duration_ms"], 0)

    def test_span_captures_exception(self):
        try:
            with Span("failing_op", span_type="tool") as span:
                raise ValueError("something broke")
        except ValueError:
            pass

        d = span.to_dict()
        self.assertEqual(d["status"], "error")
        self.assertIn("something broke", d["error_message"])

    def test_span_custom_error_message_preserved(self):
        try:
            with Span("custom_err") as span:
                span.error_message = "custom error reason"
                raise RuntimeError("stdlib error")
        except RuntimeError:
            pass

        d = span.to_dict()
        self.assertEqual(d["status"], "error")
        # Custom message should be preserved, not overwritten
        self.assertEqual(d["error_message"], "custom error reason")

    def test_span_timestamps_are_iso8601(self):
        with Span("timed") as span:
            pass

        d = span.to_dict()
        # Should be parseable ISO 8601
        datetime.fromisoformat(d["started_at"].replace("Z", "+00:00"))
        datetime.fromisoformat(d["ended_at"].replace("Z", "+00:00"))

    def test_span_omits_none_fields(self):
        with Span("minimal") as span:
            pass

        d = span.to_dict()
        self.assertNotIn("model", d)
        self.assertNotIn("input", d)
        self.assertNotIn("output", d)
        self.assertNotIn("input_tokens", d)
        self.assertNotIn("cost_usd", d)
        self.assertNotIn("error_message", d)
        self.assertNotIn("parent_client_span_id", d)


class TestSession(unittest.TestCase):
    """Session collection and flush tests."""

    def test_session_collects_spans(self):
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {"session_id": "test", "span_ids": [], "spans_ingested": 0}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        with agent.session("Test Run", _send_fn=capture) as session:
            with session.span("step_1", span_type="llm") as s:
                s.input = {"msg": "hello"}
            with session.span("step_2", span_type="tool") as s:
                s.input = {"query": "data"}

        self.assertEqual(captured["session_name"], "Test Run")
        self.assertEqual(len(captured["spans"]), 2)
        self.assertEqual(captured["spans"][0]["name"], "step_1")
        self.assertEqual(captured["spans"][1]["name"], "step_2")

    def test_session_with_session_id(self):
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        with agent.session("Run", session_id="custom-123", _send_fn=capture) as session:
            with session.span("op") as s:
                pass

        self.assertEqual(captured["session_id"], "custom-123")

    def test_nested_spans_parent_child(self):
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        with agent.session("Nested", _send_fn=capture) as session:
            with session.span("parent_op", span_type="agent") as parent:
                parent.input = {"task": "test"}

                with session.span("child_1", span_type="llm", parent=parent) as c1:
                    c1.model = "gpt-4o"

                with session.span("child_2", span_type="tool", parent=parent) as c2:
                    c2.input = {"q": "data"}

        spans = captured["spans"]
        self.assertEqual(len(spans), 3)

        parent_id = spans[0]["client_span_id"]
        self.assertNotIn("parent_client_span_id", spans[0])  # root has no parent
        self.assertEqual(spans[1]["parent_client_span_id"], parent_id)
        self.assertEqual(spans[2]["parent_client_span_id"], parent_id)

    def test_session_flushes_even_on_exception(self):
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        try:
            with agent.session("Failing", _send_fn=capture) as session:
                with session.span("ok_step") as s:
                    s.output = "fine"
                with session.span("bad_step") as s:
                    raise RuntimeError("boom")
        except RuntimeError:
            pass

        # Session should have flushed both spans despite the exception
        self.assertEqual(len(captured["spans"]), 2)
        self.assertEqual(captured["spans"][1]["status"], "error")
        self.assertIn("boom", captured["spans"][1]["error_message"])

    def test_empty_session_does_not_send(self):
        send_called = False

        def capture(payload):
            nonlocal send_called
            send_called = True
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        with agent.session("Empty", _send_fn=capture) as session:
            pass

        self.assertFalse(send_called)


class TestDecorator(unittest.TestCase):
    """@agent.trace() decorator tests."""

    def test_trace_decorator_captures_io(self):
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        # Monkey-patch the session factory to inject _send_fn
        orig_session = agent.session

        def patched_session(name, session_id=None, *, _send_fn=None):
            return orig_session(name, session_id, _send_fn=capture)

        agent.session = patched_session

        @agent.trace("classify", span_type="llm")
        def classify(msg):
            return {"intent": "support"}

        result = classify("help me")

        self.assertEqual(result, {"intent": "support"})
        self.assertEqual(len(captured["spans"]), 1)
        self.assertEqual(captured["spans"][0]["name"], "classify")
        self.assertEqual(captured["spans"][0]["span_type"], "llm")
        self.assertEqual(captured["spans"][0]["output"], {"intent": "support"})

    def test_trace_decorator_captures_exception(self):
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        orig_session = agent.session

        def patched_session(name, session_id=None, *, _send_fn=None):
            return orig_session(name, session_id, _send_fn=capture)

        agent.session = patched_session

        @agent.trace("risky_op", span_type="tool")
        def risky():
            raise ConnectionError("network down")

        with self.assertRaises(ConnectionError):
            risky()

        self.assertEqual(captured["spans"][0]["status"], "error")
        self.assertIn("network down", captured["spans"][0]["error_message"])


class TestAgentDecodeInit(unittest.TestCase):
    """Constructor validation tests."""

    def test_missing_api_key_raises(self):
        with self.assertRaises(ValueError):
            AgentDecode(api_key="", endpoint="http://localhost")

    def test_missing_endpoint_raises(self):
        with self.assertRaises(ValueError):
            AgentDecode(api_key="al_test", endpoint="")

    def test_endpoint_trailing_slash_stripped(self):
        agent = AgentDecode(api_key="al_test", endpoint="http://localhost:3000/")
        self.assertEqual(agent.endpoint, "http://localhost:3000")


class TestPayloadFormat(unittest.TestCase):
    """Verify the payload matches what the server expects."""

    def test_payload_has_correct_top_level_keys(self):
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        with agent.session("Format Test", _send_fn=capture) as session:
            with session.span("op", span_type="llm") as s:
                s.model = "gpt-4o"

        # Server expects: session_name (str), spans (array)
        self.assertIn("session_name", captured)
        self.assertIn("spans", captured)
        self.assertIsInstance(captured["spans"], list)

    def test_span_type_values_match_server_enum(self):
        """Server accepts: llm, tool, chain, retrieval, agent, embedding, rerank, guardrail, other."""
        valid_types = ["llm", "tool", "chain", "retrieval", "agent"]

        for st in valid_types:
            with Span("test", span_type=st) as span:
                pass
            self.assertEqual(span.to_dict()["span_type"], st)

    def test_status_values_match_server_enum(self):
        """Server accepts: ok, error."""
        with Span("test_ok") as span:
            pass
        self.assertEqual(span.to_dict()["status"], "ok")

        try:
            with Span("test_err") as span:
                raise Exception("fail")
        except Exception:
            pass
        self.assertEqual(span.to_dict()["status"], "error")

    def test_payload_is_json_serializable(self):
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        with agent.session("JSON Test", _send_fn=capture) as session:
            with session.span("op", span_type="llm") as s:
                s.model = "gpt-4o"
                s.input = {"nested": {"deep": [1, 2, 3]}}
                s.output = {"text": "hello"}
                s.input_tokens = 10
                s.output_tokens = 5
                s.cost_usd = 0.001
                s.metadata = {"version": "1.0"}

        # Must not raise
        serialized = json.dumps(captured, default=str)
        parsed = json.loads(serialized)
        self.assertEqual(parsed["session_name"], "JSON Test")


if __name__ == "__main__":
    unittest.main()
