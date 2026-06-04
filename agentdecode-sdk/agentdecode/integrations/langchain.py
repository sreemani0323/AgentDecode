import uuid
from typing import Any, Dict, List, Optional
from agentdecode.tracer import AgentDecodeTracer, SessionContext

try:
    try:
        from langchain_core.callbacks import BaseCallbackHandler
    except ImportError:
        from langchain.callbacks.base import BaseCallbackHandler
    HAS_LANGCHAIN = True
except ImportError:
    HAS_LANGCHAIN = False
    class BaseCallbackHandler:
        pass

class AgentDecodeCallbackHandler(BaseCallbackHandler):
    """Callback Handler that logs to AgentDecode."""
    
    def __init__(self, api_key: str, base_url: str = "http://localhost:3000", session_name: str = "LangChain Agent"):
        if not HAS_LANGCHAIN:
            raise ImportError("langchain is not installed. Please install it with `pip install langchain-core`.")
        self.tracer = AgentDecodeTracer(api_key=api_key, base_url=base_url)
        self.session_name = session_name
        self.session = None
        self.active_spans = {}
        
    def on_chain_start(self, serialized: Dict[str, Any], inputs: Dict[str, Any], **kwargs: Any) -> Any:
        if self.session is None:
            self.session = self.tracer.session(self.session_name)
            self.session.__enter__()
            
        run_id = kwargs.get("run_id")
        if run_id:
            span = self.session.span(name=serialized.get("name", "chain"), span_type="chain")
            span.__enter__()
            span.input = inputs
            self.active_spans[run_id] = span
            
    def on_chain_end(self, outputs: Dict[str, Any], **kwargs: Any) -> Any:
        run_id = kwargs.get("run_id")
        if run_id and run_id in self.active_spans:
            span = self.active_spans.pop(run_id)
            span.output = outputs
            span.__exit__(None, None, None)
            
        # If no more active spans, end the session
        if not self.active_spans and self.session:
            self.session.__exit__(None, None, None)
            self.session = None

    def on_chain_error(self, error: Exception, **kwargs: Any) -> Any:
        run_id = kwargs.get("run_id")
        if run_id and run_id in self.active_spans:
            span = self.active_spans.pop(run_id)
            span.__exit__(type(error), error, None)
            
        if not self.active_spans and self.session:
            self.session.__exit__(None, None, None)
            self.session = None

    def on_llm_start(self, serialized: Dict[str, Any], prompts: List[str], **kwargs: Any) -> Any:
        run_id = kwargs.get("run_id")
        if run_id:
            span = self.session.span(name=serialized.get("name", "llm"), span_type="llm")
            span.__enter__()
            span.input = {"prompts": prompts}
            span.model = kwargs.get("invocation_params", {}).get("model_name")
            self.active_spans[run_id] = span

    def on_llm_end(self, response: Any, **kwargs: Any) -> Any:
        run_id = kwargs.get("run_id")
        if run_id and run_id in self.active_spans:
            span = self.active_spans.pop(run_id)
            
            # Try to extract usage metadata
            if hasattr(response, "llm_output") and response.llm_output:
                token_usage = response.llm_output.get("token_usage", {})
                span.input_tokens = token_usage.get("prompt_tokens")
                span.output_tokens = token_usage.get("completion_tokens")
                
            # Extract generated text
            if hasattr(response, "generations") and response.generations:
                texts = []
                for gen_list in response.generations:
                    for gen in gen_list:
                        texts.append(gen.text)
                span.output = {"generations": texts}
                
            span.__exit__(None, None, None)

    def on_llm_error(self, error: Exception, **kwargs: Any) -> Any:
        run_id = kwargs.get("run_id")
        if run_id and run_id in self.active_spans:
            span = self.active_spans.pop(run_id)
            span.__exit__(type(error), error, None)

    def on_tool_start(self, serialized: Dict[str, Any], input_str: str, **kwargs: Any) -> Any:
        run_id = kwargs.get("run_id")
        if run_id:
            span = self.session.span(name=serialized.get("name", "tool"), span_type="tool")
            span.__enter__()
            span.input = {"input": input_str}
            self.active_spans[run_id] = span

    def on_tool_end(self, output: Any, **kwargs: Any) -> Any:
        run_id = kwargs.get("run_id")
        if run_id and run_id in self.active_spans:
            span = self.active_spans.pop(run_id)
            span.output = {"output": str(output)}
            span.__exit__(None, None, None)

    def on_tool_error(self, error: Exception, **kwargs: Any) -> Any:
        run_id = kwargs.get("run_id")
        if run_id and run_id in self.active_spans:
            span = self.active_spans.pop(run_id)
            span.__exit__(type(error), error, None)
