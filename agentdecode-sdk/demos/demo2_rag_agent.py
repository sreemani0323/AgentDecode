# AgentDecode Demo — RAG Agent (Retrieval Augmented Generation)
# This script simulates a RAG agent and sends traces to AgentDecode
#
# Setup:
# 1. pip install agentdecode (or: cd .. && pip install -e .)
# 2. Set your API key: set AGENTDECODE_API_KEY=your_key_here
# 3. Run: python demo2_rag_agent.py
# 4. Open your AgentDecode dashboard to see the traces

import os
import sys
import time

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

def run_rag_agent():
    question = "What are the best practices for Python async programming?"
    print(f'[Demo] User question: {question}')
    print(f'[Demo] Running RAG pipeline...')

    with tracer.session(name="RAG Agent") as session:
        # Step 1: Embed query
        with session.span(name="embed_query", span_type="llm") as span:
            span.model = "text-embedding-3-small"
            span.input = {"text": question}
            time.sleep(0.2)
            span.output = {"embedding_dim": 1536, "model": "text-embedding-3-small"}
            span.input_tokens = 12
            span.output_tokens = 0
            span.cost_usd = 0.00001
            print(f'  [1/4] embed_query -> Embedded (1536 dims)')

        # Step 2: Search vectors
        with session.span(name="search_vectors", span_type="retrieval") as span:
            span.input = {"query_embedding": "[0.023, -0.041, ...]", "top_k": 5, "index": "docs_v2"}
            time.sleep(0.3)
            # Return irrelevant results on purpose
            span.output = {
                "results": [
                    {"title": "JavaScript Event Loop Explained", "score": 0.72, "snippet": "The event loop is a fundamental concept in JavaScript..."},
                    {"title": "Introduction to Go Goroutines", "score": 0.68, "snippet": "Goroutines are lightweight threads managed by Go runtime..."},
                    {"title": "Python GIL Explained", "score": 0.65, "snippet": "The Global Interpreter Lock prevents multiple threads..."},
                    {"title": "Rust Async/Await Tutorial", "score": 0.61, "snippet": "Rust uses a zero-cost abstraction for async..."},
                    {"title": "Node.js Streams Guide", "score": 0.58, "snippet": "Streams are collections of data that might not be available all at once..."},
                ],
                "total_results": 5
            }
            print(f'  [2/4] search_vectors -> Found 5 results (mostly irrelevant!)')

        # Step 3: Rerank — returns low quality score
        with session.span(name="rerank_results", span_type="llm") as span:
            span.model = "llama-3.3-70b-versatile"
            span.input = {
                "query": question,
                "documents": ["JavaScript Event Loop...", "Go Goroutines...", "Python GIL...", "Rust Async...", "Node.js Streams..."],
                "instruction": "Score relevance of each document to the query from 0-10"
            }
            time.sleep(0.3)
            # Low quality output — results are not relevant to Python async best practices
            span.output = {
                "reranked": [
                    {"title": "Python GIL Explained", "relevance": 4.2},
                    {"title": "JavaScript Event Loop Explained", "relevance": 2.1},
                    {"title": "Go Goroutines", "relevance": 1.8},
                    {"title": "Rust Async/Await Tutorial", "relevance": 1.5},
                    {"title": "Node.js Streams Guide", "relevance": 0.9},
                ],
                "max_relevance": 4.2,
                "quality_assessment": "Poor - no documents directly address Python async best practices"
            }
            span.input_tokens = 200
            span.output_tokens = 85
            span.cost_usd = 0.0003
            print(f'  [3/4] rerank_results -> Low quality (max relevance: 4.2/10)')

        # Step 4: Generate answer
        with session.span(name="generate_answer", span_type="llm") as span:
            span.model = "llama-3.3-70b-versatile"
            span.input = {
                "prompt": f"Based on the following context, answer: {question}",
                "context": "Python GIL prevents multiple threads from executing Python bytecodes simultaneously...",
                "system": "Answer the question based only on the provided context. If the context is insufficient, say so."
            }
            time.sleep(0.5)
            span.output = {
                "answer": "Based on the available information, Python's async programming is related to the Global Interpreter Lock (GIL). The GIL prevents multiple threads from executing Python bytecodes simultaneously. For async programming, you should consider using asyncio module, though the provided context doesn't cover specific best practices in detail.",
                "confidence": 0.45,
                "sources_used": 1
            }
            span.input_tokens = 150
            span.output_tokens = 78
            span.cost_usd = 0.0004
            print(f'  [4/4] generate_answer -> Generated (low confidence: 0.45)')

    print(f'[Demo] Done! Check your AgentDecode dashboard.')
    print(f'[Demo] This demo shows silent failure detection — the RAG pipeline produced a low-quality answer')
    print(f'       because the vector search returned irrelevant results.')

if __name__ == '__main__':
    run_rag_agent()
