import { NextResponse } from "next/server"

// Gate 006B: liveness/readiness probe for Azure Container Apps.
// No auth, no database, no Supabase, no secrets. Excluded from proxy.ts.
export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.json(
    { status: "ok" },
    { status: 200, headers: { "cache-control": "no-store" } }
  )
}
