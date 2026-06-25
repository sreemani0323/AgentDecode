import { NextResponse } from 'next/server'
import { getFeatureStatus } from '@/lib/featureFlags'

/**
 * GET /api/features
 *
 * Returns which optional features are enabled based on server env vars.
 * No auth required — this only exposes boolean flags, not secrets.
 */
export async function GET() {
  return NextResponse.json(getFeatureStatus(), {
    headers: {
      'Cache-Control': 'public, max-age=60', // Cache for 60s
    },
  })
}
