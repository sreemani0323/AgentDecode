import uuid
import datetime
import json
import threading
import functools
import urllib.request
import urllib.error
from contextlib import contextmanager

class SpanContext:
    def __init__(self, session, name: str, span_type: str):
        self.session = session
        self.client_span_id = str(uuid.uuid4())
        self.name = name
        self.span_type = span_type
        self.status = "ok"
        self.started_at = None
        self.ended_at = None
        self.duration_ms = None
        self.model = None
        self.input = None
        self.output = None
        self.error_message = None
        self.input_tokens = None
        self.output_tokens = None
        self.cost_usd = None
        self.metadata = {}
        self.parent_client_span_id = None
        
    def __enter__(self):
        self.started_at = datetime.datetime.utcnow().isoformat() + "Z"
        # Set parent span if there is an active span in the thread context
        if hasattr(self.session.tracer._thread_local, 'current_span_id'):
            self.parent_client_span_id = self.session.tracer._thread_local.current_span_id
        
        # Make this span the current active span
        self._previous_span_id = getattr(self.session.tracer._thread_local, 'current_span_id', None)
        self.session.tracer._thread_local.current_span_id = self.client_span_id
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.ended_at = datetime.datetime.utcnow().isoformat() + "Z"
        
        # Calculate duration
        start = datetime.datetime.fromisoformat(self.started_at.replace('Z', '+00:00'))
        end = datetime.datetime.fromisoformat(self.ended_at.replace('Z', '+00:00'))
        self.duration_ms = int((end - start).total_seconds() * 1000)

        if exc_type is not None:
            self.status = "error"
            self.error_message = str(exc_val)
            
        # Restore previous active span
        self.session.tracer._thread_local.current_span_id = self._previous_span_id
            
        span_data = {
            "client_span_id": self.client_span_id,
            "parent_client_span_id": self.parent_client_span_id,
            "name": self.name,
            "span_type": self.span_type,
            "status": self.status,
            "started_at": self.started_at,
            "ended_at": self.ended_at,
            "duration_ms": self.duration_ms,
        }
        
        if self.model is not None: span_data["model"] = self.model
        if self.input is not None: span_data["input"] = self.input
        if self.output is not None: span_data["output"] = self.output
        if self.error_message is not None: span_data["error_message"] = self.error_message
        if self.input_tokens is not None: span_data["input_tokens"] = self.input_tokens
        if self.output_tokens is not None: span_data["output_tokens"] = self.output_tokens
        if self.cost_usd is not None: span_data["cost_usd"] = self.cost_usd
        if self.metadata: span_data["metadata"] = self.metadata
            
        self.session.spans.append(span_data)
        
        # If this is the root span, do not suppress the exception
        return False

class SessionContext:
    def __init__(self, tracer, name: str, session_id: str = None):
        self.tracer = tracer
        self.name = name
        self.session_id = session_id or str(uuid.uuid4())
        self.spans = []

    def __enter__(self):
        self.tracer._thread_local.current_session = self
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        # Unset current session
        self.tracer._thread_local.current_session = None
        
        if not self.spans:
            return False

        payload = {
            "session_id": self.session_id,
            "session_name": self.name,
            "spans": self.spans
        }

        try:
            req = urllib.request.Request(
                f"{self.tracer.base_url}/api/ingest",
                data=json.dumps(payload).encode('utf-8'),
                headers={
                    "Authorization": f"Bearer {self.tracer.api_key}",
                    "Content-Type": "application/json"
                },
                method="POST"
            )
            with urllib.request.urlopen(req, timeout=15.0) as response:
                if response.getcode() == 200:
                    print(f"[AgentDecode] Session '{self.name}' ingested successfully.")
                else:
                    print(f"[AgentDecode] Failed to ingest session '{self.name}': HTTP {response.getcode()}")
        except urllib.error.HTTPError as e:
            error_body = e.read().decode('utf-8')
            print(f"[AgentDecode] Failed to ingest session '{self.name}': HTTP {e.code} - {error_body}")
        except Exception as e:
            print(f"[AgentDecode] Error sending traces: {str(e)}")
            
        return False

    def span(self, name: str, span_type: str = "tool") -> SpanContext:
        return SpanContext(self, name, span_type)

class AgentDecodeTracer:
    def __init__(self, api_key: str, base_url: str = "http://localhost:3000"):
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self._thread_local = threading.local()

    def session(self, name: str, session_id: str = None) -> SessionContext:
        return SessionContext(self, name, session_id)

    def span(self, name: str, span_type: str = "agent"):
        def decorator(func):
            @functools.wraps(func)
            def wrapper(*args, **kwargs):
                # Ensure we have an active session, otherwise create a temporary one
                active_session = getattr(self._thread_local, 'current_session', None)
                is_temp_session = False
                
                if not active_session:
                    active_session = self.session(name=f"auto_{func.__name__}")
                    active_session.__enter__()
                    is_temp_session = True

                with active_session.span(name, span_type) as sp:
                    try:
                        # Serialize inputs simply
                        sp.input = {"args": [str(a) for a in args], "kwargs": {k: str(v) for k, v in kwargs.items()}}
                        result = func(*args, **kwargs)
                        # Assume result is serializable or cast to string
                        if isinstance(result, (dict, list, str, int, float, bool)):
                            sp.output = result
                        else:
                            sp.output = str(result)
                        return result
                    except Exception as e:
                        sp.error_message = str(e)
                        sp.status = "error"
                        raise e
                    finally:
                        if is_temp_session:
                            active_session.__exit__(None, None, None)
            return wrapper
        return decorator

def init(api_key: str, base_url: str = "http://localhost:3000") -> AgentDecodeTracer:
    return AgentDecodeTracer(api_key, base_url)
