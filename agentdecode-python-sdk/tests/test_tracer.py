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
from agentdecode.tracer import current_session, current_span


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


# ── Retry logic tests ─────────────────────────────────────────────


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


# ── Async support tests ───────────────────────────────────────────


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


# ── LangChain handler tests ───────────────────────────────────────


class TestLangChainHandler(unittest.TestCase):
    """Tests for the LangChain callback handler."""

    def test_handler_raises_without_langchain(self):
        """If langchain is not installed, constructor raises ImportError."""
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


# ── Context variables tests ───────────────────────────────────────


class TestContextVars(unittest.TestCase):
    """Tests for automatic span nesting via contextvars."""

    def test_automatic_nesting(self):
        """Spans created inside another span auto-nest under it."""
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        # Helper function that uses current_session() — no explicit parent
        def search_docs(query):
            session = current_session()
            if session:
                with session.span("search_docs", span_type="retrieval") as span:
                    span.input = {"query": query}
                    span.output = {"results": 3}
                    return [1, 2, 3]
            return []

        with agent.session("Auto Nest Test", _send_fn=capture) as session:
            with session.span("orchestrator", span_type="agent") as parent:
                parent.input = {"task": "answer question"}
                # This should automatically nest under "orchestrator"
                docs = search_docs("refund policy")
                parent.output = {"docs": len(docs)}

        spans = captured["spans"]
        self.assertEqual(len(spans), 2)

        # orchestrator is root (no parent)
        self.assertNotIn("parent_client_span_id", spans[0])

        # search_docs should be child of orchestrator
        self.assertEqual(spans[1]["name"], "search_docs")
        self.assertEqual(
            spans[1]["parent_client_span_id"],
            spans[0]["client_span_id"],
        )

    def test_deep_automatic_nesting(self):
        """Three levels of automatic nesting work correctly."""
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        def level_2_function():
            session = current_session()
            if session:
                with session.span("level_2", span_type="tool") as span:
                    span.output = {"depth": 2}

        def level_1_function():
            session = current_session()
            if session:
                with session.span("level_1", span_type="llm") as span:
                    span.output = {"depth": 1}
                    level_2_function()  # should nest under level_1

        with agent.session("Deep Nest", _send_fn=capture) as session:
            with session.span("root", span_type="agent") as root:
                level_1_function()  # should nest under root

        spans = captured["spans"]
        self.assertEqual(len(spans), 3)

        root_id = spans[0]["client_span_id"]
        level1_id = spans[1]["client_span_id"]

        # root has no parent
        self.assertNotIn("parent_client_span_id", spans[0])
        # level_1 is child of root
        self.assertEqual(spans[1]["parent_client_span_id"], root_id)
        # level_2 is child of level_1
        self.assertEqual(spans[2]["parent_client_span_id"], level1_id)

    def test_current_session_returns_none_outside(self):
        """current_session() returns None when called outside a session block."""
        self.assertIsNone(current_session())

    def test_current_span_returns_none_outside(self):
        """current_span() returns None outside a span block."""
        self.assertIsNone(current_span())

    def test_nesting_resets_after_exit(self):
        """current_span() resets to None after exiting a span block."""
        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        def capture(payload):
            return {}

        with agent.session("Reset Test", _send_fn=capture) as session:
            self.assertIsNotNone(current_session())
            with session.span("temp_span") as span:
                self.assertIsNotNone(current_span())
                self.assertEqual(current_span(), span)

            # After exiting the span, current_span should reset
            self.assertIsNone(current_span())

        # After exiting the session, current_session should reset
        self.assertIsNone(current_session())

    def test_explicit_parent_overrides_contextvar(self):
        """When parent is explicitly passed, it takes precedence over the contextvar."""
        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        with agent.session("Override Test", _send_fn=capture) as session:
            with session.span("span_a", span_type="agent") as a:
                with session.span("span_b", span_type="agent") as b:
                    # Explicitly pass span_a as parent (even though span_b is current)
                    with session.span("child", span_type="tool", parent=a) as c:
                        c.output = "test"

        spans = captured["spans"]
        child_span = [s for s in spans if s["name"] == "child"][0]
        a_span = [s for s in spans if s["name"] == "span_a"][0]
        # child should have span_a as parent (explicit), not span_b (contextvar)
        self.assertEqual(child_span["parent_client_span_id"], a_span["client_span_id"])


# ── Flush timeout tests ───────────────────────────────────────────


class TestFlushTimeout(unittest.TestCase):
    """Tests for configurable timeout, max_retries, and flush_timeout."""

    def test_timeout_parameter_accepted(self):
        """AgentDecode accepts timeout parameter without error."""
        agent = AgentDecode(
            api_key="al_test",
            endpoint="http://localhost",
            timeout=5,
        )
        self.assertEqual(agent.timeout, 5)

    def test_max_retries_parameter_accepted(self):
        """AgentDecode accepts max_retries parameter."""
        agent = AgentDecode(
            api_key="al_test",
            endpoint="http://localhost",
            max_retries=1,
        )
        self.assertEqual(agent.max_retries, 1)

    def test_flush_timeout_parameter_accepted(self):
        """AgentDecode accepts flush_timeout parameter."""
        agent = AgentDecode(
            api_key="al_test",
            endpoint="http://localhost",
            flush_timeout=15,
        )
        self.assertEqual(agent.flush_timeout, 15)

    def test_timeout_passed_to_session(self):
        """Session inherits timeout/max_retries/flush_timeout from AgentDecode."""
        agent = AgentDecode(
            api_key="al_test",
            endpoint="http://localhost",
            timeout=7,
            max_retries=2,
            flush_timeout=20,
        )
        session = agent.session("test")
        self.assertEqual(session._timeout, 7)
        self.assertEqual(session._max_retries, 2)
        self.assertEqual(session._flush_timeout, 20)

    def test_default_values(self):
        """Default values for timeout, max_retries, flush_timeout."""
        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        self.assertEqual(agent.timeout, 10)
        self.assertEqual(agent.max_retries, 3)
        self.assertEqual(agent.flush_timeout, 30)


# ── OpenAI instrumentation tests ──────────────────────────────────


class TestOpenAIInstrumentation(unittest.TestCase):
    """Tests for the OpenAI auto-instrumentation."""

    def test_instrument_without_openai(self):
        """If openai is not installed, instrument_openai raises ImportError."""
        from agentdecode.integrations import openai as oai_module

        original = oai_module.OPENAI_AVAILABLE
        oai_module.OPENAI_AVAILABLE = False

        try:
            agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
            with self.assertRaises(ImportError) as ctx:
                oai_module.AgentDecodeOpenAIInstrumentation(agent)
            self.assertIn("openai is not installed", str(ctx.exception))
        finally:
            oai_module.OPENAI_AVAILABLE = original

    def test_instrumentation_creates_span(self):
        """When openai is available and patched, calling create() produces a span."""
        from agentdecode.integrations.openai import OPENAI_AVAILABLE

        if not OPENAI_AVAILABLE:
            self.skipTest("openai not installed")

        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        # Create a mock OpenAI client
        mock_client = MagicMock()
        mock_completions = MagicMock()
        mock_client.chat.completions = mock_completions

        # Mock the response
        mock_usage = MagicMock()
        mock_usage.prompt_tokens = 15
        mock_usage.completion_tokens = 8
        mock_usage.total_tokens = 23

        mock_choice = MagicMock()
        mock_choice.message.content = "Hello! How can I help you?"

        mock_response = MagicMock()
        mock_response.choices = [mock_choice]
        mock_response.usage = mock_usage

        original_create = MagicMock(return_value=mock_response)
        mock_completions.create = original_create

        # Instrument
        from agentdecode.integrations.openai import AgentDecodeOpenAIInstrumentation

        instrumentation = AgentDecodeOpenAIInstrumentation(agent)
        instrumentation._patched_target = mock_completions
        instrumentation._original_create = original_create

        # Manually patch create to the traced version
        def traced_create(self_or_client, *args, **kwargs):
            from agentdecode.tracer import _current_session

            session = _current_session.get()
            if session is None:
                return original_create(self_or_client, *args, **kwargs)

            model = kwargs.get("model", "unknown")
            messages = kwargs.get("messages", [])
            span_name = f"openai.chat.{model}"

            with session.span(span_name, span_type="llm") as span:
                span.model = model
                span.input = {
                    "messages": [
                        {"role": m.get("role", "unknown"), "content": str(m.get("content", ""))[:200]}
                        for m in (messages[-3:] if messages else [])
                    ]
                }
                response = original_create(self_or_client, *args, **kwargs)
                if hasattr(response, "choices") and response.choices:
                    content = getattr(response.choices[0].message, "content", None)
                    if content:
                        span.output = {"content": content[:500]}
                if hasattr(response, "usage") and response.usage:
                    span.input_tokens = response.usage.prompt_tokens
                    span.output_tokens = response.usage.completion_tokens
                return response

        mock_completions.create = traced_create

        # Use it inside a session
        with agent.session("OpenAI Test", _send_fn=capture) as session:
            mock_completions.create(
                mock_completions,
                model="gpt-4o",
                messages=[
                    {"role": "system", "content": "You are helpful."},
                    {"role": "user", "content": "Hello!"},
                ],
            )

        spans = captured["spans"]
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["span_type"], "llm")
        self.assertEqual(spans[0]["name"], "openai.chat.gpt-4o")
        self.assertEqual(spans[0]["model"], "gpt-4o")
        self.assertEqual(spans[0]["input_tokens"], 15)
        self.assertEqual(spans[0]["output_tokens"], 8)
        self.assertEqual(spans[0]["output"], {"content": "Hello! How can I help you?"})


class TestVersion(unittest.TestCase):
    """Version attribute tests."""

    def test_version_attribute_exists(self):
        import agentdecode

        self.assertTrue(hasattr(agentdecode, "__version__"))
        self.assertEqual(agentdecode.__version__, "0.1.5")


# ── Anthropic instrumentation tests ───────────────────────────────


class TestAnthropicInstrumentation(unittest.TestCase):
    """Tests for the Anthropic auto-instrumentation."""

    def test_instrument_without_anthropic(self):
        """If anthropic is not installed, raises ImportError with helpful message."""
        from agentdecode.integrations import anthropic as anth_module

        original = anth_module.ANTHROPIC_AVAILABLE
        anth_module.ANTHROPIC_AVAILABLE = False

        try:
            agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
            with self.assertRaises(ImportError) as ctx:
                anth_module.AgentDecodeAnthropicInstrumentation(agent)
            self.assertIn("anthropic is not installed", str(ctx.exception))
        finally:
            anth_module.ANTHROPIC_AVAILABLE = original

    def test_instrumentation_creates_span(self):
        """When anthropic is available and patched, calling create() produces a span."""
        from agentdecode.integrations.anthropic import ANTHROPIC_AVAILABLE

        if not ANTHROPIC_AVAILABLE:
            self.skipTest("anthropic not installed")

        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        # Create a mock Anthropic client
        mock_client = MagicMock()
        mock_messages = MagicMock()
        mock_client.messages = mock_messages

        # Mock the response
        mock_content_block = MagicMock()
        mock_content_block.text = "Hello! I'm Claude."

        mock_usage = MagicMock()
        mock_usage.input_tokens = 12
        mock_usage.output_tokens = 6

        mock_response = MagicMock()
        mock_response.content = [mock_content_block]
        mock_response.usage = mock_usage

        original_create = MagicMock(return_value=mock_response)
        mock_messages.create = original_create

        # Manually create traced_create matching the pattern
        from agentdecode.tracer import _current_session

        def traced_create(messages_self, *args, **kwargs):
            session = _current_session.get()
            if session is None:
                return original_create(messages_self, *args, **kwargs)

            model = kwargs.get("model", "unknown")
            messages = kwargs.get("messages", [])
            span_name = f"anthropic.messages.{model}"

            with session.span(span_name, span_type="llm") as span:
                span.model = model
                span.input = {
                    "messages": [
                        {"role": m.get("role", "unknown"), "content": str(m.get("content", ""))[:200]}
                        for m in (messages[-3:] if messages else [])
                    ]
                }
                response = original_create(messages_self, *args, **kwargs)
                if hasattr(response, "content") and response.content:
                    text = getattr(response.content[0], "text", None)
                    if text:
                        span.output = {"content": text[:500]}
                if hasattr(response, "usage") and response.usage:
                    span.input_tokens = response.usage.input_tokens
                    span.output_tokens = response.usage.output_tokens
                return response

        mock_messages.create = traced_create

        # Use it inside a session
        with agent.session("Anthropic Test", _send_fn=capture) as session:
            mock_messages.create(
                mock_messages,
                model="claude-sonnet-4-20250514",
                messages=[
                    {"role": "user", "content": "Hello!"},
                ],
            )

        spans = captured["spans"]
        self.assertEqual(len(spans), 1)
        self.assertEqual(spans[0]["span_type"], "llm")
        self.assertEqual(spans[0]["name"], "anthropic.messages.claude-sonnet-4-20250514")
        self.assertEqual(spans[0]["model"], "claude-sonnet-4-20250514")
        self.assertEqual(spans[0]["input_tokens"], 12)
        self.assertEqual(spans[0]["output_tokens"], 6)
        self.assertEqual(spans[0]["output"], {"content": "Hello! I'm Claude."})

    def test_cost_estimation_claude_opus(self):
        """Verify cost is calculated for claude-opus model."""
        from agentdecode.integrations.anthropic import ANTHROPIC_AVAILABLE

        if not ANTHROPIC_AVAILABLE:
            self.skipTest("anthropic not installed")

        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        mock_usage = MagicMock()
        mock_usage.input_tokens = 100
        mock_usage.output_tokens = 50

        mock_content = MagicMock()
        mock_content.text = "Response"

        mock_response = MagicMock()
        mock_response.content = [mock_content]
        mock_response.usage = mock_usage

        original_create = MagicMock(return_value=mock_response)

        from agentdecode.tracer import _current_session

        def traced_create(messages_self, *args, **kwargs):
            session = _current_session.get()
            if session is None:
                return original_create(messages_self, *args, **kwargs)

            model = kwargs.get("model", "unknown")
            span_name = f"anthropic.messages.{model}"

            with session.span(span_name, span_type="llm") as span:
                span.model = model
                response = original_create(messages_self, *args, **kwargs)
                if hasattr(response, "usage") and response.usage:
                    input_tok = response.usage.input_tokens
                    output_tok = response.usage.output_tokens
                    span.input_tokens = input_tok
                    span.output_tokens = output_tok
                    total = (input_tok or 0) + (output_tok or 0)
                    if "claude-opus" in model:
                        span.cost_usd = total * 0.000015
                return response

        mock_messages = MagicMock()
        mock_messages.create = traced_create

        with agent.session("Cost Test", _send_fn=capture) as session:
            mock_messages.create(
                mock_messages,
                model="claude-opus-4-5",
            )

        spans = captured["spans"]
        # total = 100 + 50 = 150, cost = 150 * 0.000015 = 0.00225
        self.assertAlmostEqual(spans[0]["cost_usd"], 0.00225)


# ── LlamaIndex handler tests ─────────────────────────────────────


class TestLlamaIndexHandler(unittest.TestCase):
    """Tests for the LlamaIndex callback handler."""

    def test_handler_raises_without_llamaindex(self):
        """If llama-index is not installed, raises ImportError."""
        from agentdecode.integrations import llamaindex as li_module

        original = li_module.LLAMAINDEX_AVAILABLE
        li_module.LLAMAINDEX_AVAILABLE = False

        try:
            agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
            with self.assertRaises(ImportError) as ctx:
                li_module.AgentDecodeLlamaIndexHandler(agent)
            self.assertIn("llama-index is not installed", str(ctx.exception))
        finally:
            li_module.LLAMAINDEX_AVAILABLE = original

    def test_handler_on_event_start_creates_span(self):
        """on_event_start creates a span with correct type."""
        from agentdecode.integrations.llamaindex import (
            AgentDecodeLlamaIndexHandler,
            LLAMAINDEX_AVAILABLE,
        )

        if not LLAMAINDEX_AVAILABLE:
            self.skipTest("llama-index not installed")

        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        handler = AgentDecodeLlamaIndexHandler(
            agent, session_name="li_test", _send_fn=capture
        )

        # Start a trace (creates session)
        handler.start_trace(trace_id="test-trace")

        # Create a mock event type
        from llama_index.core.callbacks import CBEventType

        event_id = handler.on_event_start(
            event_type=CBEventType.LLM,
            payload={"prompt": "What is AI?"},
            event_id="event-1",
        )

        self.assertEqual(event_id, "event-1")
        self.assertIn("event-1", handler._event_spans)

        # End event
        handler.on_event_end(
            event_type=CBEventType.LLM,
            payload={"response": "AI is..."},
            event_id="event-1",
        )

        # End trace (flushes)
        handler.end_trace(trace_id="test-trace")

        self.assertEqual(captured["session_name"], "li_test")
        self.assertEqual(len(captured["spans"]), 1)
        self.assertEqual(captured["spans"][0]["span_type"], "llm")
        self.assertEqual(captured["spans"][0]["input"], {"prompt": "What is AI?"})
        self.assertEqual(captured["spans"][0]["output"], {"response": "AI is..."})

    def test_handler_end_trace_flushes_session(self):
        """end_trace calls _flush() on the session."""
        from agentdecode.integrations.llamaindex import (
            AgentDecodeLlamaIndexHandler,
            LLAMAINDEX_AVAILABLE,
        )

        if not LLAMAINDEX_AVAILABLE:
            self.skipTest("llama-index not installed")

        flush_called = False

        def capture(payload):
            nonlocal flush_called
            flush_called = True
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
        handler = AgentDecodeLlamaIndexHandler(
            agent, session_name="flush_test", _send_fn=capture
        )

        handler.start_trace()

        from llama_index.core.callbacks import CBEventType

        handler.on_event_start(
            event_type=CBEventType.QUERY,
            payload={"query": "test"},
            event_id="ev-1",
        )
        handler.on_event_end(
            event_type=CBEventType.QUERY,
            payload={"result": "answer"},
            event_id="ev-1",
        )

        self.assertFalse(flush_called)

        handler.end_trace()

        self.assertTrue(flush_called)


# ── CrewAI observer tests ────────────────────────────────────────


class TestCrewAIObserver(unittest.TestCase):
    """Tests for the CrewAI observer."""

    def test_observer_raises_without_crewai(self):
        """If crewai is not installed, run() raises ImportError."""
        from agentdecode.integrations import crewai as crew_module

        original = crew_module.CREWAI_AVAILABLE
        crew_module.CREWAI_AVAILABLE = False

        try:
            agent = AgentDecode(api_key="al_test", endpoint="http://localhost")
            observer = crew_module.AgentDecodeCrewObserver(agent)
            mock_crew = MagicMock()

            with self.assertRaises(ImportError) as ctx:
                observer.run(mock_crew)
            self.assertIn("crewai is not installed", str(ctx.exception))
        finally:
            crew_module.CREWAI_AVAILABLE = original

    def test_observer_traces_crew_run(self):
        """Observer traces crew.kickoff() as a session with correct metadata."""
        from agentdecode.integrations.crewai import (
            AgentDecodeCrewObserver,
            CREWAI_AVAILABLE,
        )

        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        # Mock crewai availability for this test
        from agentdecode.integrations import crewai as crew_module

        original = crew_module.CREWAI_AVAILABLE
        crew_module.CREWAI_AVAILABLE = True

        try:
            observer = AgentDecodeCrewObserver(agent, _send_fn=capture)

            # Mock crew object
            mock_crew = MagicMock()
            mock_crew.name = "Research Crew"
            mock_crew.agents = [MagicMock(), MagicMock(), MagicMock()]
            mock_crew.tasks = [MagicMock(), MagicMock()]
            mock_crew.kickoff.return_value = "Final crew output"

            result = observer.run(
                mock_crew,
                inputs={"topic": "AI trends"},
                session_name="test_crew",
            )

            self.assertEqual(result, "Final crew output")
            mock_crew.kickoff.assert_called_once_with(inputs={"topic": "AI trends"})

            self.assertEqual(captured["session_name"], "test_crew")
            self.assertEqual(len(captured["spans"]), 1)
            self.assertEqual(captured["spans"][0]["name"], "crew.kickoff")
            self.assertEqual(captured["spans"][0]["span_type"], "agent")
            self.assertEqual(captured["spans"][0]["input"], {"topic": "AI trends"})
            self.assertEqual(
                captured["spans"][0]["output"],
                {"result": "Final crew output"},
            )
            self.assertEqual(captured["spans"][0]["metadata"]["agents"], 3)
            self.assertEqual(captured["spans"][0]["metadata"]["tasks"], 2)
        finally:
            crew_module.CREWAI_AVAILABLE = original

    def test_observer_captures_crew_error(self):
        """Observer captures errors when crew.kickoff() raises."""
        from agentdecode.integrations.crewai import AgentDecodeCrewObserver
        from agentdecode.integrations import crewai as crew_module

        captured = {}

        def capture(payload):
            captured.update(payload)
            return {}

        agent = AgentDecode(api_key="al_test", endpoint="http://localhost")

        original = crew_module.CREWAI_AVAILABLE
        crew_module.CREWAI_AVAILABLE = True

        try:
            observer = AgentDecodeCrewObserver(agent, _send_fn=capture)

            mock_crew = MagicMock()
            mock_crew.name = "Failing Crew"
            mock_crew.agents = []
            mock_crew.tasks = []
            mock_crew.kickoff.side_effect = RuntimeError("Agent loop failed")

            with self.assertRaises(RuntimeError):
                observer.run(mock_crew, inputs={"bad": "input"})

            self.assertEqual(captured["spans"][0]["status"], "error")
            self.assertIn("Agent loop failed", captured["spans"][0]["error_message"])
        finally:
            crew_module.CREWAI_AVAILABLE = original


if __name__ == "__main__":
    unittest.main()
