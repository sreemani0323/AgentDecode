import sys
import os
import time

# Add the local sdk to the path so we import the local code, not a pip installed package
sys.path.insert(0, os.path.abspath(os.path.dirname(__file__)))

from agentdecode import init

def main():
    API_KEY = "al_cdafd0779f304a726b841b7d3a00b74b"
    print("[TEST] Testing AgentDecode Python SDK...")
    
    tracer = init(api_key=API_KEY)
    
    with tracer.session("SDK Test Agent") as session:
        # Span 1: Tool (Success)
        with session.span("tool.fetch_data", span_type="tool") as span:
            span.input = {"source": "database"}
            time.sleep(0.5)  # Simulate work
            span.output = {"records": [1, 2, 3]}
            
        # Span 2: LLM (Success)
        with session.span("llm.analyze", span_type="llm") as span:
            span.model = "gemini-1.5-flash"
            span.input = {"prompt": "Analyze these records: [1, 2, 3]"}
            time.sleep(1.2)  # Simulate LLM generation
            span.output = {"response": "The records are sequential integers."}
            span.input_tokens = 15
            span.output_tokens = 8
            
        # Span 3: Tool (Error)
        try:
            with session.span("tool.save_result", span_type="tool") as span:
                span.input = {"data": "The records are sequential integers.", "destination": "S3"}
                time.sleep(0.3)
                raise ConnectionError("Timeout connecting to AWS S3 bucket after 5000ms")
        except ConnectionError:
            # We catch it here so the script doesn't crash, but the span will correctly record the error
            pass
            
    print("\n[SUCCESS] Session complete. Traces should be sent.")
    print("[LINK] Open http://localhost:3000/dashboard to see the traces")

if __name__ == "__main__":
    main()
