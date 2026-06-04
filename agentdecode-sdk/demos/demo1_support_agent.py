# AgentDecode Demo — Customer Support Agent
# This script simulates a real AI agent and sends traces to AgentDecode
#
# Setup:
# 1. pip install agentdecode (or: cd .. && pip install -e .)
# 2. Set your API key: set AGENTDECODE_API_KEY=your_key_here
# 3. Run: python demo1_support_agent.py
# 4. Open your AgentDecode dashboard to see the traces

import os
import sys
import time

# Add parent directory to path for local development
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from agentdecode import init

API_KEY = os.environ.get('AGENTDECODE_API_KEY', '')
BASE_URL = os.environ.get('AGENTDECODE_BASE_URL', 'http://localhost:3000')

if not API_KEY:
    print('ERROR: Set AGENTDECODE_API_KEY environment variable first.')
    print('  Windows: set AGENTDECODE_API_KEY=al_your_key_here')
    print('  Linux/Mac: export AGENTDECODE_API_KEY=al_your_key_here')
    sys.exit(1)

print(f'[Demo] Initializing AgentDecode tracer (base_url={BASE_URL})')
tracer = init(api_key=API_KEY, base_url=BASE_URL)

def run_support_agent():
    user_question = "My order hasn't arrived, what should I do?"
    print(f'[Demo] User question: {user_question}')
    print(f'[Demo] Running support agent pipeline...')

    with tracer.session(name="Customer Support Agent") as session:
        # Step 1: Classify intent
        with session.span(name="classify_intent", span_type="llm") as span:
            span.model = "llama-3.3-70b-versatile"
            span.input = {"prompt": f"Classify the intent of this customer query: '{user_question}'", "system": "You are an intent classifier."}
            time.sleep(0.3)  # Simulate LLM call
            span.output = {"intent": "order_status", "confidence": 0.94}
            span.input_tokens = 45
            span.output_tokens = 12
            span.cost_usd = 0.0001
            print(f'  [1/4] classify_intent -> order_status (confidence: 0.94)')

        # Step 2: Search knowledge base — DELIBERATELY FAILS
        with session.span(name="search_knowledge_base", span_type="tool") as span:
            span.input = {"query": "order not arrived delivery status", "database": "support_kb"}
            time.sleep(0.5)  # Simulate DB call
            span.status = "error"
            span.error_message = "Database connection timeout: Could not connect to knowledge base after 3 retries"
            print(f'  [2/4] search_knowledge_base -> ERROR: Database connection timeout')

        # Step 3: Generate response (with fallback)
        with session.span(name="generate_response", span_type="llm") as span:
            span.model = "llama-3.3-70b-versatile"
            span.input = {
                "prompt": f"Answer this customer question without knowledge base context: '{user_question}'",
                "system": "You are a helpful customer support agent. The knowledge base is unavailable, use general knowledge."
            }
            time.sleep(0.4)  # Simulate LLM call
            span.output = {
                "response": "I apologize for the inconvenience. Please check your order tracking number in your confirmation email. If your order is past the estimated delivery date, please contact our support team with your order number and we'll investigate immediately."
            }
            span.input_tokens = 78
            span.output_tokens = 52
            span.cost_usd = 0.0002
            print(f'  [3/4] generate_response -> Generated fallback response')

        # Step 4: Send reply
        with session.span(name="send_reply", span_type="tool") as span:
            span.input = {"channel": "chat", "user_id": "user_12345"}
            time.sleep(0.1)  # Simulate sending
            span.output = {"sent": True, "message_id": "msg_abc123"}
            print(f'  [4/4] send_reply -> Message sent successfully')

    print(f'[Demo] Done! Check your AgentDecode dashboard.')

if __name__ == '__main__':
    run_support_agent()
