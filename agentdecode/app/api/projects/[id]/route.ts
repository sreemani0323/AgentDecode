import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

type RouteContext = {
  params: Promise<{ id: string }>;
};

/**
 * GET /api/projects/[id]
 *
 * Retrieve a single project by ID, including aggregated session statistics.
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
    const { id: projectId } = await context.params;
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

    // Fetch the project
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", projectId)
      .single();

    if (projectError || !project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      );
    }

    // Verify user belongs to the project's organization
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

    // Fetch aggregated session stats for the project
    const { data: sessions, error: sessionsError } = await supabase
      .from("sessions")
      .select("id, status, span_count, error_count, total_tokens, total_cost_usd")
      .eq("project_id", projectId);

    const stats = {
      total_sessions: sessions?.length || 0,
      total_spans: 0,
      total_errors: 0,
      total_tokens: 0,
      total_cost_usd: 0,
    };

    if (sessions && !sessionsError) {
      for (const session of sessions) {
        stats.total_spans += session.span_count || 0;
        stats.total_errors += session.error_count || 0;
        stats.total_tokens += session.total_tokens || 0;
        stats.total_cost_usd += session.total_cost_usd || 0;
      }
    }

    return NextResponse.json(
      { project: { ...project, stats } },
      { status: 200 }
    );
  } catch (error) {
    logger.error("GET /api/projects/[id] error", error as Error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/projects/[id]
 *
 * Update a project's name and/or description.
 */
export async function PATCH(
  request: NextRequest,
  context: RouteContext
) {
  const rateLimit = checkRateLimit(request, 'write')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  try {
    const { id: projectId } = await context.params;
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

    // Parse the request body
    let body: { name?: string; description?: string };

    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    if (!body.name && body.description === undefined) {
      return NextResponse.json(
        { error: "At least one of 'name' or 'description' is required" },
        { status: 400 }
      );
    }

    // Fetch the project to verify ownership
    const { data: existingProject, error: lookupError } = await supabase
      .from("projects")
      .select("org_id")
      .eq("id", projectId)
      .single();

    if (lookupError || !existingProject) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      );
    }

    // Verify user belongs to the project's organization
    const { data: membership, error: memberError } = await supabase
      .from("org_members")
      .select("org_id")
      .eq("user_id", user.id)
      .eq("org_id", existingProject.org_id)
      .single();

    if (memberError || !membership) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      );
    }

    // Build the update payload
    const updatePayload: Record<string, string | null> = {};

    if (body.name && typeof body.name === "string" && body.name.trim()) {
      updatePayload.name = body.name.trim();
    }

    if (body.description !== undefined) {
      updatePayload.description =
        typeof body.description === "string"
          ? body.description.trim() || null
          : null;
    }

    const { data: updatedProject, error: updateError } = await supabase
      .from("projects")
      .update(updatePayload)
      .eq("id", projectId)
      .select("*")
      .single();

    if (updateError) {
      logger.error("Failed to update project", new Error(updateError.message));
      return NextResponse.json(
        { error: "Failed to update project" },
        { status: 500 }
      );
    }

    return NextResponse.json({ project: updatedProject }, { status: 200 });
  } catch (error) {
    logger.error("PATCH /api/projects/[id] error", error as Error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/projects/[id]
 *
 * Delete a project. Cascading deletes (sessions, spans, etc.) should be
 * handled at the database level via foreign key ON DELETE CASCADE.
 */
export async function DELETE(
  request: NextRequest,
  context: RouteContext
) {
  const rateLimit = checkRateLimit(request, 'write')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  try {
    const { id: projectId } = await context.params;
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

    // Fetch the project to verify ownership
    const { data: existingProject, error: lookupError } = await supabase
      .from("projects")
      .select("org_id")
      .eq("id", projectId)
      .single();

    if (lookupError || !existingProject) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      );
    }

    // Verify user belongs to the project's organization
    const { data: membership, error: memberError } = await supabase
      .from("org_members")
      .select("org_id, role")
      .eq("user_id", user.id)
      .eq("org_id", existingProject.org_id)
      .single();

    if (memberError || !membership) {
      return NextResponse.json(
        { error: "Forbidden" },
        { status: 403 }
      );
    }

    // Only owners and admins can delete projects
    if (!["owner", "admin"].includes(membership.role)) {
      return NextResponse.json(
        { error: "Insufficient permissions. Only owners and admins can delete projects." },
        { status: 403 }
      );
    }

    const { error: deleteError } = await supabase
      .from("projects")
      .delete()
      .eq("id", projectId);

    if (deleteError) {
      logger.error("Failed to delete project", new Error(deleteError.message));
      return NextResponse.json(
        { error: "Failed to delete project" },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { message: "Project deleted successfully" },
      { status: 200 }
    );
  } catch (error) {
    logger.error("DELETE /api/projects/[id] error", error as Error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
