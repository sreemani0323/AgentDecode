import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

type RouteContext = {
  params: Promise<{ id: string }>;
};

interface SpanRow {
  id: string;
  session_id: string;
  project_id: string;
  parent_span_id: string | null;
  name: string;
  span_type: string;
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number | null;
  input: unknown;
  output: unknown;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error_message: string | null;
  metadata: unknown;
  created_at: string;
  eval_scores: EvalScore | null;
  ai_explanations: AiExplanation | null;
}

interface EvalScore {
  span_id: string;
  score: number;
  reasoning: string | null;
  flagged: boolean;
  generated_at: string;
}

interface AiExplanation {
  span_id: string;
  diagnosis: string;
  suggested_fix: string;
  generated_at: string;
}

interface SpanTreeNode extends Omit<SpanRow, "eval_scores" | "ai_explanations"> {
  eval_scores: EvalScore | null;
  ai_explanations: AiExplanation | null;
  children: SpanTreeNode[];
}

/**
 * Build a nested span tree from a flat list of spans.
 * Root spans (no parent_span_id) become top-level nodes.
 */
function buildSpanTree(spans: SpanRow[]): SpanTreeNode[] {
  const nodeMap = new Map<string, SpanTreeNode>();

  // Create tree nodes for each span
  for (const span of spans) {
    nodeMap.set(span.id, {
      ...span,
      children: [],
    });
  }

  const roots: SpanTreeNode[] = [];

  // Wire up parent-child relationships
  for (const span of spans) {
    const node = nodeMap.get(span.id)!;

    if (span.parent_span_id && nodeMap.has(span.parent_span_id)) {
      nodeMap.get(span.parent_span_id)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Sort children by start_time at every level
  function sortChildren(nodes: SpanTreeNode[]) {
    nodes.sort(
      (a, b) =>
        new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
    );
    for (const node of nodes) {
      sortChildren(node.children);
    }
  }

  sortChildren(roots);

  return roots;
}

/**
 * GET /api/sessions/[id]
 *
 * Retrieve a single session with all its spans (as a nested tree),
 * eval_scores, and ai_explanations.
 */
export async function GET(
  request: NextRequest,
  context: RouteContext
) {
  const rateLimit = checkRateLimit(request, 'read')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  try {
    const { id: sessionId } = await context.params;
    const supabase = await createClient();

    // Verify the user is authenticated
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Fetch the session
    const { data: session, error: sessionError } = await supabase
      .from("sessions")
      .select("*")
      .eq("id", sessionId)
      .single();

    if (sessionError || !session) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }

    // Verify user belongs to the project's organization
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("org_id")
      .eq("id", session.project_id)
      .single();

    if (projectError || !project) {
      return NextResponse.json(
        { error: "Project not found for this session" },
        { status: 404 }
      );
    }

    const { data: membership, error: memberError } = await supabase
      .from("org_members")
      .select("org_id")
      .eq("user_id", user.id)
      .eq("org_id", project.org_id)
      .single();

    if (memberError || !membership) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      );
    }

    // Fetch all spans for this session, joining eval_scores and ai_explanations
    const { data: spans, error: spansError } = await supabase
      .from("spans")
      .select(
        `
        *,
        eval_scores (
          span_id,
          score,
          reasoning,
          flagged,
          generated_at
        ),
        ai_explanations (
          span_id,
          diagnosis,
          suggested_fix,
          generated_at
        )
      `
      )
      .eq("session_id", sessionId)
      .order("started_at", { ascending: true });

    if (spansError) {
      logger.error("Failed to fetch spans", new Error(spansError.message));
      return NextResponse.json(
        { error: "Failed to fetch spans" },
        { status: 500 }
      );
    }

    // Build the nested span tree
    const spanTree = buildSpanTree((spans as SpanRow[]) || []);

    return NextResponse.json(
      {
        session: {
          ...session,
          spans: spanTree,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    logger.error("GET /api/sessions/[id] error", error as Error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
