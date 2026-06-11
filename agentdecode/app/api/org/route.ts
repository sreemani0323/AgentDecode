import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { checkRateLimit } from '@/lib/rate-limit';

export async function GET(request: NextRequest) {
  const rateLimit = checkRateLimit(request, 'read')
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

    const { data: membership, error: memberError } = await supabase
      .from('org_members')
      .select('*, organizations(*)')
      .eq('user_id', user.id)
      .limit(1)
      .single();

    if (memberError || !membership) {
      return NextResponse.json(
        { error: 'Organization not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(membership.organizations);
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
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

    const body = await request.json();
    const { name } = body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { error: 'name is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    const { data: membership, error: memberError } = await supabase
      .from('org_members')
      .select('org_id, role')
      .eq('user_id', user.id)
      .eq('role', 'owner')
      .limit(1)
      .single();

    if (memberError || !membership) {
      return NextResponse.json(
        { error: 'Only organization owners can update settings' },
        { status: 403 }
      );
    }

    const { data: updatedOrg, error: updateError } = await supabase
      .from('organizations')
      .update({ name: name.trim() })
      .eq('id', membership.org_id)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json(
        { error: 'Failed to update organization' },
        { status: 500 }
      );
    }

    return NextResponse.json(updatedOrg);
  } catch {
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
