// test-ingest.js — Send fake agent telemetry to AgentDecode ingest endpoint

const API_KEY = "al_cdafd0779f304a726b841b7d3a00b74b";
const INGEST_URL = "http://localhost:3000/api/ingest";

const payload = {
  session_id: "test-session-001",
  session_name: "Customer Support Agent",
  spans: [
    {
      name: "agent.run",
      span_type: "agent",
      status: "ok",
      started_at: "2026-06-03T10:00:00.000Z",
      ended_at: "2026-06-03T10:00:08.500Z",
      duration_ms: 8500,
      metadata: { user_query: "What is my order status?" }
    },
    {
      name: "tool.search_orders",
      span_type: "tool",
      status: "ok",
      started_at: "2026-06-03T10:00:01.000Z",
      ended_at: "2026-06-03T10:00:02.500Z",
      duration_ms: 1500,
      input: { query: "order status user_123" },
      output: { results: ["Order #456 - Shipped", "Order #789 - Processing"] }
    },
    {
      name: "llm.generate_response",
      span_type: "llm",
      status: "ok",
      started_at: "2026-06-03T10:00:03.000Z",
      ended_at: "2026-06-03T10:00:06.000Z",
      duration_ms: 3000,
      model: "gemini-1.5-flash",
      input: { prompt: "Based on these orders, answer: What is my order status?" },
      output: { response: "Your order #456 has been shipped and will arrive in 2-3 days." },
      input_tokens: 245,
      output_tokens: 38,
      cost_usd: 0.000142
    },
    {
      name: "tool.send_email",
      span_type: "tool",
      status: "error",
      started_at: "2026-06-03T10:00:06.500Z",
      ended_at: "2026-06-03T10:00:07.000Z",
      duration_ms: 500,
      input: { to: "user@example.com", subject: "Order Update" },
      error_message: "SMTP connection timeout: Could not connect to mail server after 3 retries"
    }
  ]
};

async function main() {
  console.log("🚀 Sending telemetry to AgentDecode...\n");

  try {
    const res = await fetch(INGEST_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json();

    console.log(`Status: ${res.status}`);
    console.log("Response:", JSON.stringify(data, null, 2));

    if (res.ok) {
      console.log("\n✅ Success! Ingested", data.spans_ingested, "spans into session", data.session_id);
      console.log("\n🔗 View it at: http://localhost:3000/sessions/" + data.session_id);
    } else {
      console.log("\n❌ Failed:", data.error);
    }
  } catch (err) {
    console.error("❌ Request failed:", err.message);
  }
}

main();
