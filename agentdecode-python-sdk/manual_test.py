# -*- coding: utf-8 -*-
"""Manual integration test: send a real trace via SDK to the live API."""

import sys
import os
import json
import hashlib
import secrets
import time

env_path = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "agentdecode", ".env.local"
)
if os.path.exists(env_path):
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip())

SUPABASE_URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

if not SUPABASE_URL or not SERVICE_KEY:
    print("ERROR: Cannot load Supabase credentials from .env.local")
    sys.exit(1)

from urllib.request import Request, urlopen

def sb_request(method, path, body=None):
    url = SUPABASE_URL + path
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, method=method)
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", "Bearer " + SERVICE_KEY)
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())

def sb_admin_auth(method, path, body=None):
    url = SUPABASE_URL + "/auth/v1/admin" + path
    data = json.dumps(body).encode() if body else None
    req = Request(url, data=data, method=method)
    req.add_header("apikey", SERVICE_KEY)
    req.add_header("Authorization", "Bearer " + SERVICE_KEY)
    req.add_header("Content-Type", "application/json")
    with urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode())

print("=" * 60)
print("MANUAL INTEGRATION TEST -- AgentDecode Python SDK")
print("=" * 60)

email = "sdk-test-%d@test.com" % int(time.time())
password = "TestPass123!"

print("\n1. Creating test user: " + email)
user = sb_admin_auth("POST", "/users", {
    "email": email,
    "password": password,
    "email_confirm": True,
    "user_metadata": {"full_name": "SDK Test User"},
})
user_id = user["id"]
print("   User ID: " + user_id)

time.sleep(2)

print("2. Finding auto-created organization...")
orgs = sb_request("GET", "/rest/v1/org_members?user_id=eq." + user_id + "&select=org_id")
if not orgs:
    print("   ERROR: No org created!")
    sb_admin_auth("DELETE", "/users/" + user_id)
    sys.exit(1)
org_id = orgs[0]["org_id"]
print("   Org ID: " + org_id)

print("3. Creating project...")
projects = sb_request("POST", "/rest/v1/projects", {
    "org_id": org_id,
    "name": "SDK Integration Test",
    "description": "Testing the Python SDK"
})
project_id = projects[0]["id"] if isinstance(projects, list) else projects["id"]
print("   Project ID: " + project_id)

print("4. Generating API key...")
raw_key = "al_" + secrets.token_hex(16)
key_hash = hashlib.sha256(raw_key.encode()).hexdigest()
key_prefix = raw_key[:12]
sb_request("POST", "/rest/v1/api_keys", {
    "project_id": project_id,
    "key_hash": key_hash,
    "key_prefix": key_prefix,
    "is_active": True,
})
print("   API Key: " + raw_key)

print("\n" + "=" * 60)
print("SENDING REAL TRACE VIA SDK")
print("=" * 60)

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from agentdecode import AgentDecode

agent = AgentDecode(api_key=raw_key, endpoint="http://localhost:3000")

print("\nCreating session with 3 nested spans...")

with agent.session("Customer Support Agent - SDK Test") as session:
    with session.span("classify_intent", span_type="llm") as s1:
        s1.model = "gpt-4o-mini"
        s1.input = {"messages": [{"role": "user", "content": "What is the status of order #12345?"}]}
        s1.output = {"intent": "order_status", "confidence": 0.95}
        s1.input_tokens = 32
        s1.output_tokens = 12
        s1.cost_usd = 0.0001

    with session.span("search_knowledge_base", span_type="retrieval", parent=s1) as s2:
        s2.input = {"query": "order #12345 status", "top_k": 5}
        s2.output = {"documents": [], "count": 0}

    with session.span("generate_response", span_type="llm", parent=s1) as s3:
        s3.model = "gpt-4o"
        s3.input = {"system": "Answer using ONLY the provided context.", "context": [], "question": "What is the status of order #12345?"}
        s3.output = {"response": "Your order #12345 is being processed and will arrive by Friday."}
        s3.error_message = "Hallucination: generated tracking info with zero context"
        s3.input_tokens = 95
        s3.output_tokens = 42
        s3.cost_usd = 0.003
        s3._status = "error"

print("\n[OK] Session sent!")

print("\n" + "=" * 60)
print("VERIFYING DATA IN DATABASE")
print("=" * 60)

time.sleep(2)

print("\n1. Checking sessions...")
sessions_data = sb_request("GET", "/rest/v1/sessions?project_id=eq." + project_id + "&select=id,name,status,span_count,error_count,total_tokens,total_cost_usd")
if sessions_data:
    s = sessions_data[0]
    print("   [OK] Session: " + s["name"])
    print("     status=%s, spans=%s, errors=%s, tokens=%s, cost=$%s" % (s["status"], s["span_count"], s["error_count"], s.get("total_tokens"), s.get("total_cost_usd")))
    session_id = s["id"]
else:
    print("   [FAIL] NO SESSION FOUND")
    session_id = None

if session_id:
    print("\n2. Checking spans...")
    spans_data = sb_request("GET", "/rest/v1/spans?session_id=eq." + session_id + "&select=id,name,span_type,status,error_message,parent_span_id&order=started_at.asc")
    for sp in spans_data:
        parent_str = "parent=%s..." % sp["parent_span_id"][:8] if sp.get("parent_span_id") else "root"
        err_str = " -- " + sp["error_message"][:50] if sp.get("error_message") else ""
        print("   %s (%s) [%s] (%s)%s" % (sp["name"], sp["span_type"], sp["status"], parent_str, err_str))

    cs = next((sp for sp in spans_data if sp["name"] == "classify_intent"), None)
    ss = next((sp for sp in spans_data if sp["name"] == "search_knowledge_base"), None)
    gs = next((sp for sp in spans_data if sp["name"] == "generate_response"), None)

    if cs and ss and gs:
        if ss.get("parent_span_id") == cs["id"] and gs.get("parent_span_id") == cs["id"]:
            print("\n   [OK] Parent-child linking CORRECT")
        else:
            print("\n   [FAIL] Parent-child linking BROKEN")

    print("\n3. Checking issues...")
    issues_data = sb_request("GET", "/rest/v1/issues?project_id=eq." + project_id + "&select=id,title,status,occurrence_count")
    if issues_data:
        print("   [OK] Issue created: " + issues_data[0]["title"][:60])
    else:
        print("   [WARN] No issue auto-created")

    print("\n4. Checking eval scores...")
    time.sleep(3)
    found_evals = False
    for sp in spans_data:
        evals = sb_request("GET", "/rest/v1/eval_scores?span_id=eq." + sp["id"] + "&select=score,reasoning,flagged")
        if evals:
            e = evals[0]
            print("   [OK] %s: score=%s, flagged=%s" % (sp["name"], e["score"], e["flagged"]))
            found_evals = True
    if not found_evals:
        print("   [WARN] No eval scores yet")

print("\n" + "=" * 60)
print("CLEANUP")
print("=" * 60)
sb_request("DELETE", "/rest/v1/projects?id=eq." + project_id)
sb_admin_auth("DELETE", "/users/" + user_id)
print("[OK] Test data cleaned up")

print("\n" + "=" * 60)
print("RESULT: SDK integration test COMPLETE")
print("=" * 60)
