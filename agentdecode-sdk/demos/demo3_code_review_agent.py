# AgentDecode Demo — Code Review Agent
# This script simulates a code review agent and sends traces to AgentDecode
#
# Setup:
# 1. pip install agentdecode (or: cd .. && pip install -e .)
# 2. Set your API key: set AGENTDECODE_API_KEY=your_key_here
# 3. Run: python demo3_code_review_agent.py
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

SAMPLE_CODE = '''
def process_user_data(user_input):
    import sqlite3
    conn = sqlite3.connect('users.db')
    cursor = conn.cursor()
    query = f"SELECT * FROM users WHERE name = '{user_input}'"
    cursor.execute(query)
    results = cursor.fetchall()
    
    processed = []
    for row in results:
        processed.append({
            'name': row[0],
            'email': row[1],
            'password': row[2],  # Storing plaintext passwords!
        })
    return processed
'''

def run_code_review_agent():
    print(f'[Demo] Code to review:')
    print(SAMPLE_CODE)
    print(f'[Demo] Running code review pipeline...')

    with tracer.session(name="Code Review Agent") as session:
        # Step 1: Parse code
        with session.span(name="parse_code", span_type="tool") as span:
            span.input = {"code": SAMPLE_CODE, "language": "python"}
            time.sleep(0.2)
            span.output = {
                "ast_nodes": 14,
                "functions": ["process_user_data"],
                "imports": ["sqlite3"],
                "lines_of_code": 15,
                "complexity": "low"
            }
            print(f'  [1/4] parse_code -> 14 AST nodes, 1 function, complexity: low')

        # Step 2: Analyze security — RAISES EXCEPTION
        with session.span(name="analyze_security", span_type="tool") as span:
            span.input = {"code": SAMPLE_CODE, "scanner": "bandit", "severity": "all"}
            time.sleep(0.3)
            # Simulate scanner timeout
            span.status = "error"
            span.error_message = "SecurityScanner timeout after 30s: Connection to security scanning service timed out. The scanner may be overloaded or the code snippet is too complex for real-time analysis."
            print(f'  [2/4] analyze_security -> ERROR: SecurityScanner timeout after 30s')

        # Step 3: Analyze performance
        with session.span(name="analyze_performance", span_type="llm") as span:
            span.model = "llama-3.3-70b-versatile"
            span.input = {
                "prompt": f"Analyze this Python code for performance issues:\n{SAMPLE_CODE}",
                "system": "You are a senior Python performance engineer. Identify performance issues."
            }
            time.sleep(0.4)
            span.output = {
                "issues": [
                    {
                        "severity": "medium",
                        "line": 3,
                        "issue": "Database connection created on every call without connection pooling",
                        "suggestion": "Use connection pooling or context manager"
                    },
                    {
                        "severity": "low",
                        "line": 8,
                        "issue": "fetchall() loads all results into memory",
                        "suggestion": "Use fetchone() or fetchmany() for large result sets"
                    }
                ],
                "overall_score": 5.5
            }
            span.input_tokens = 120
            span.output_tokens = 95
            span.cost_usd = 0.0003
            print(f'  [3/4] analyze_performance -> Found 2 issues (score: 5.5/10)')

        # Step 4: Generate report
        with session.span(name="generate_report", span_type="llm") as span:
            span.model = "llama-3.3-70b-versatile"
            span.input = {
                "prompt": "Generate a code review report based on the analysis results.",
                "security_analysis": "FAILED - scanner timeout",
                "performance_analysis": {"issues_found": 2, "score": 5.5},
                "system": "Generate a comprehensive code review report."
            }
            time.sleep(0.5)
            span.output = {
                "report": {
                    "summary": "Code review completed with partial results. Security analysis failed due to scanner timeout.",
                    "security": {
                        "status": "INCOMPLETE",
                        "note": "Security scanner timed out. Manual review recommended.",
                        "visible_issues": [
                            "SQL injection vulnerability (f-string in query)",
                            "Plaintext password storage"
                        ]
                    },
                    "performance": {
                        "status": "REVIEWED",
                        "score": "5.5/10",
                        "issues": 2
                    },
                    "recommendation": "BLOCK MERGE — Critical security issues detected manually despite scanner failure"
                }
            }
            span.input_tokens = 180
            span.output_tokens = 130
            span.cost_usd = 0.0005
            print(f'  [4/4] generate_report -> BLOCK MERGE (critical security issues)')

    print(f'[Demo] Done! Check your AgentDecode dashboard.')
    print(f'[Demo] This demo shows error tracking — the security scanner timed out,')
    print(f'       but the agent still produced a useful report with manual findings.')

if __name__ == '__main__':
    run_code_review_agent()
