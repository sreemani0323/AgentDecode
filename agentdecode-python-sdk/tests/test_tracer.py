"""Unit tests for the AgentDecode Python SDK.

All tests use an injectable _send_fn to capture payloads without
hitting the network.
"""

import asyncio
import json
import sys
import time
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

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

    def test_span_start_finish_methods(self):
        """Test the _start() and _finish() internal helpers."""
        span = Span("manual_op", span_type="llm")
        span._start()
        span.model = "gpt-4o"
        span.input = {"prompt": "test"}
        span.output = {"text": "response"}
        span._finish()

        d = span.to_dict()
        self.assertEqual(d["name"], "manual_op")
        self.assertIn("started_at", d)
        self.assertIn("ended_at", d)
        self.assertIsInstance(d["duration_ms"], int)
        self.assertGreaterEqual(d["duration_ms"], 0)


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

    def test_start_span_internal_method(self):
        """Test _start_span() for non-context-manager usage."""
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        session = agent._start_session("Manual Session", _send_fn=capture)

        span = session._start_span("manual_op", span_type="llm")
        span.model = "gpt-4o"
        span.input = {"prompt": "test"}
        span.output = {"text": "response"}
        span._finish()

        session._flush()

        self.assertEqual(captured["session_name"], "Manual Session")
        self.assertEqual(len(captured["spans"]), 1)
        self.assertEqual(captured["spans"][0]["name"], "manual_op")
        self.assertIn("started_at", captured["spans"][0])
        self.assertIn("ended_at", captured["spans"][0])


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


# ── NEW: Retry logic tests ────────────────────────────────────────


class TestRetryLogic(unittest.TestCase):
    """Tests for _http_post retry with exponential backoff."""

    @patch("agentdecode.tracer.urlopen")
    @patch("agentdecode.tracer.time.sleep")
    def test_retries_on_failure_then_succeeds(self, mock_sleep, mock_urlopen):
        """Mock _http_post to fail twice then succeed on third attempt."""
        from agentdecode.tracer import _http_post
        from urllib.error import URLError

        # First two calls fail, third succeeds
        mock_response = MagicMock()
        mock_response.read.return_value = b'{"ok": true}'
        mock_response.__enter__ = MagicMock(return_value=mock_response)
        mock_response.__exit__ = MagicMock(return_value=False)

        mock_urlopen.side_effect = [
            URLError("connection refused"),
            URLError("connection refused"),
            mock_response,
        ]

        result = _http_post(
            url="http://localhost/api/ingest",
            api_key="al_test",
            payload={"session_name": "test", "spans": []},
        )

        self.assertEqual(result, {"ok": True})
        self.assertEqual(mock_urlopen.call_count, 3)
        # Should have slept twice (after first and second failure)
        self.assertEqual(mock_sleep.call_count, 2)

    @patch("agentdecode.tracer.urlopen")
    @patch("agentdecode.tracer.time.sleep")
    def test_silent_fail_on_decorator(self, mock_sleep, mock_urlopen):
        """When silent_fail=True, no exception is raised."""
        from agentdecode.tracer import _http_post
        from urllib.error import URLError

        mock_urlopen.side_effect = URLError("always fails")

        # Should NOT raise when silent_fail=True
        result = _http_post(
            url="http://localhost/api/ingest",
            api_key="al_test",
            payload={"session_name": "test", "spans": []},
            silent_fail=True,
        )

        self.assertEqual(result, {})
        self.assertEqual(mock_urlopen.call_count, 3)

    @patch("agentdecode.tracer.urlopen")
    @patch("agentdecode.tracer.time.sleep")
    def test_max_retries_exceeded_raises(self, mock_sleep, mock_urlopen):
        """When all retries fail and silent_fail=False, exception is raised."""
        from agentdecode.tracer import _http_post
        from urllib.error import URLError

        mock_urlopen.side_effect = URLError("always fails")

        with self.assertRaises(RuntimeError) as ctx:
            _http_post(
                url="http://localhost/api/ingest",
                api_key="al_test",
                payload={"session_name": "test", "spans": []},
                silent_fail=False,
            )

        self.assertIn("connection error", str(ctx.exception))
        self.assertEqual(mock_urlopen.call_count, 3)

    @patch("agentdecode.tracer.urlopen")
    @patch("agentdecode.tracer.time.sleep")
    def test_no_retry_on_4xx_client_error(self, mock_sleep, mock_urlopen):
        """4xx errors (except 429) should NOT be retried."""
        from agentdecode.tracer import _http_post
        from urllib.error import HTTPError
        from io import BytesIO

        error = HTTPError(
            url="http://localhost",
            code=400,
            msg="Bad Request",
            hdrs={},  # type: ignore
            fp=BytesIO(b'{"error": "invalid payload"}'),
        )
        mock_urlopen.side_effect = error

        with self.assertRaises(RuntimeError):
            _http_post(
                url="http://localhost/api/ingest",
                api_key="al_test",
                payload={"bad": "data"},
            )

        # Should NOT retry on 400
        self.assertEqual(mock_urlopen.call_count, 1)
        self.assertEqual(mock_sleep.call_count, 0)

    @patch("agentdecode.tracer.urlopen")
    @patch("agentdecode.tracer.time.sleep")
    def test_backoff_timing(self, mock_sleep, mock_urlopen):
        """Verify exponential backoff wait times: 0.5s, 1s."""
        from agentdecode.tracer import _http_post
        from urllib.error import URLError

        mock_urlopen.side_effect = URLError("fail")

        try:
            _http_post(
                url="http://localhost/api/ingest",
                api_key="al_test",
                payload={},
            )
        except RuntimeError:
            pass

        # Check backoff: 0.5, 1.0 (no sleep after last attempt)
        self.assertEqual(mock_sleep.call_count, 2)
        mock_sleep.assert_any_call(0.5)
        mock_sleep.assert_any_call(1.0)


# ── NEW: Async support tests ──────────────────────────────────────


class TestAsyncSupport(unittest.TestCase):
    """Tests for async @agent.trace() decorator."""

    def test_async_decorator_captures_io(self):
        """Async decorated function returns correct result and captures IO."""
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        orig_session = agent.session

        def patched_session(name, session_id=None, *, _send_fn=None):
            return orig_session(name, session_id, _send_fn=capture)

        agent.session = patched_session

        @agent.trace("async_classify", span_type="llm")
        async def classify(message: str) -> dict:
            return {"intent": "support", "confidence": 0.95}

        result = asyncio.run(classify("help me"))

        self.assertEqual(result, {"intent": "support", "confidence": 0.95})
        self.assertEqual(len(captured["spans"]), 1)
        self.assertEqual(captured["spans"][0]["name"], "async_classify")
        self.assertEqual(captured["spans"][0]["span_type"], "llm")
        self.assertEqual(
            captured["spans"][0]["output"],
            {"intent": "support", "confidence": 0.95},
        )

    def test_async_decorator_captures_exception(self):
        """Async decorated function that raises: exception propagates AND span captured."""
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        orig_session = agent.session

        def patched_session(name, session_id=None, *, _send_fn=None):
            return orig_session(name, session_id, _send_fn=capture)

        agent.session = patched_session

        @agent.trace("async_risky", span_type="tool")
        async def risky_call():
            raise ConnectionError("API timeout")

        with self.assertRaises(ConnectionError):
            asyncio.run(risky_call())

        self.assertEqual(captured["spans"][0]["status"], "error")
        self.assertIn("API timeout", captured["spans"][0]["error_message"])

    def test_async_decorator_preserves_function_name(self):
        """functools.wraps should preserve the original function name."""
        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        @agent.trace("my_func", span_type="llm")
        async def my_async_function():
            return "hello"

        self.assertEqual(my_async_function.__name__, "my_async_function")


# ── NEW: LangChain handler tests ──────────────────────────────────


class TestLangChainHandler(unittest.TestCase):
    """Tests for the LangChain callback handler."""

    def test_handler_raises_without_langchain(self):
        """If langchain is not installed, constructor raises ImportError."""
        # We simulate langchain being unavailable by patching the flag
        from agentdecode.integrations import langchain as lc_module

        original = lc_module.LANGCHAIN_AVAILABLE
        lc_module.LANGCHAIN_AVAILABLE = False

        try:
            agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
            with self.assertRaises(ImportError) as ctx:
                lc_module.AgentDecodeCallbackHandler(agent)
            self.assertIn("langchain is not installed", str(ctx.exception))
        finally:
            lc_module.LANGCHAIN_AVAILABLE = original

    def test_handler_captures_llm_call(self):
        """on_llm_start + on_llm_end creates a span with span_type=llm."""
        from agentdecode.integrations.langchain import (
            AgentDecodeCallbackHandler,
            LANGCHAIN_AVAILABLE,
        )

        if not LANGCHAIN_AVAILABLE:
            self.skipTest("langchain not installed")

        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        handler = AgentDecodeCallbackHandler(
            agent, session_name="test_llm", _send_fn=capture
        )

        # Simulate LLM start
        handler.on_llm_start(
            serialized={"name": "gpt-4o"},
            prompts=["What is 2+2?"],
            run_id="run-1",
        )

        # Simulate LLM end with mock response
        mock_generation = MagicMock()
        mock_generation.text = "4"
        mock_response = MagicMock()
        mock_response.generations = [[mock_generation]]
        mock_response.llm_output = {
            "token_usage": {"prompt_tokens": 10, "completion_tokens": 5}
        }

        handler.on_llm_end(response=mock_response, run_id="run-1")

        # Flush
        handler.on_agent_finish(finish=None, run_id="run-finish")

        self.assertEqual(captured["session_name"], "test_llm")
        self.assertEqual(len(captured["spans"]), 1)
        self.assertEqual(captured["spans"][0]["span_type"], "llm")
        self.assertEqual(captured["spans"][0]["model"], "gpt-4o")
        self.assertEqual(captured["spans"][0]["output"], {"text": "4"})
        self.assertEqual(captured["spans"][0]["input_tokens"], 10)
        self.assertEqual(captured["spans"][0]["output_tokens"], 5)

    def test_handler_captures_tool_call(self):
        """on_tool_start + on_tool_end creates a span with span_type=tool."""
        from agentdecode.integrations.langchain import (
            AgentDecodeCallbackHandler,
            LANGCHAIN_AVAILABLE,
        )

        if not LANGCHAIN_AVAILABLE:
            self.skipTest("langchain not installed")

        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        handler = AgentDecodeCallbackHandler(
            agent, session_name="test_tool", _send_fn=capture
        )

        # Start a chain first to create session
        handler.on_chain_start(
            serialized={"name": "my_chain"},
            inputs={"question": "test"},
            run_id="chain-1",
        )

        # Tool call
        handler.on_tool_start(
            serialized={"name": "search"},
            input_str="find docs about refunds",
            run_id="tool-1",
        )
        handler.on_tool_end(output="Found 3 documents", run_id="tool-1")

        # End chain
        handler.on_chain_end(outputs={"answer": "done"}, run_id="chain-1")

        # Flush
        handler.on_agent_finish(finish=None, run_id="run-finish")

        self.assertEqual(captured["session_name"], "test_tool")
        # chain span + tool span = 2
        self.assertEqual(len(captured["spans"]), 2)

        tool_span = [s for s in captured["spans"] if s["span_type"] == "tool"][0]
        self.assertEqual(tool_span["name"], "tool.search")
        self.assertEqual(tool_span["input"], {"input": "find docs about refunds"})
        self.assertEqual(tool_span["output"], {"output": "Found 3 documents"})

    def test_handler_captures_error(self):
        """on_llm_error marks span with status=error."""
        from agentdecode.integrations.langchain import (
            AgentDecodeCallbackHandler,
            LANGCHAIN_AVAILABLE,
        )

        if not LANGCHAIN_AVAILABLE:
            self.skipTest("langchain not installed")

        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        handler = AgentDecodeCallbackHandler(
            agent, session_name="test_error", _send_fn=capture
        )

        handler.on_llm_start(
            serialized={"name": "gpt-4o"},
            prompts=["test"],
            run_id="run-err",
        )
        handler.on_llm_error(error=RuntimeError("API key invalid"), run_id="run-err")
        handler.on_agent_finish(finish=None, run_id="run-finish")

        self.assertEqual(captured["spans"][0]["status"], "error")
        self.assertIn("API key invalid", captured["spans"][0]["error_message"])

    def test_handler_flushes_on_agent_finish(self):
        """on_agent_finish calls session._flush()."""
        from agentdecode.integrations.langchain import (
            AgentDecodeCallbackHandler,
            LANGCHAIN_AVAILABLE,
        )

        if not LANGCHAIN_AVAILABLE:
            self.skipTest("langchain not installed")

        flush_called = False

        def capture(payload):
            nonlocal flush_called
            flush_called = True
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        handler = AgentDecodeCallbackHandler(
            agent, session_name="flush_test", _send_fn=capture
        )

        # Create session with a span
        handler.on_llm_start(
            serialized={"name": "test"},
            prompts=["hello"],
            run_id="run-1",
        )
        handler.on_llm_end(
            response=MagicMock(generations=[], llm_output=None),
            run_id="run-1",
        )

        self.assertFalse(flush_called)

        handler.on_agent_finish(finish=None, run_id="run-finish")

        self.assertTrue(flush_called)


class TestVersion(unittest.TestCase):
    """Version attribute tests."""

    def test_version_attribute_exists(self):
        import agentdecode

        self.assertTrue(hasattr(agentdecode, "__version__"))
        self.assertEqual(agentdecode.__version__, "0.1.2")


if __name__ == "__main__":
    unittest.main()
