import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit } from '@/lib/rate-limit';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const rateLimit = checkRateLimit(request, 'write')
  if (!rateLimit.allowed) {
    return rateLimit.response
  }

  try {
    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();
    const { status } = body;

    const validStatuses = ['resolved', 'ignored', 'open'] as const;
    if (!status || !validStatuses.includes(status)) {
      return NextResponse.json(
        { error: 'Invalid status. Must be one of: resolved, ignored, open' },
        { status: 400 }
      );
    }

    // Fetch the issue to get the project_id
    const { data: issue, error: issueError } = await supabase
      .from('issues')
      .select('id, project_id')
      .eq('id', id)
      .single();

    if (issueError || !issue) {
      return NextResponse.json({ error: 'Issue not found' }, { status: 404 });
    }

    // Fetch the project to get org_id
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('org_id')
      .eq('id', issue.project_id)
      .single();

    if (projectError || !project) {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    // Verify user has access to this organization
    const { data: membership, error: memberError } = await supabase
      .from('org_members')
      .select('org_id')
      .eq('org_id', project.org_id)
      .eq('user_id', user.id)
      .single();

    if (memberError || !membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Update the issue status
    const { data: updatedIssue, error: updateError } = await supabase
      .from('issues')
      .update({ status })
      .eq('id', id)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json(
        { error: 'Failed to update issue' },
        { status: 500 }
      );
    }

    return NextResponse.json(updatedIssue);
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
