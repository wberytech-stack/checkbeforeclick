import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { getUserOrgContext, getScanStatus } from "@/lib/data"

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

  const authClient = await createClient()
  const {
    data: { user },
    error: authError,
  } = await authClient.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await getUserOrgContext(user.id)

  if (!ctx) {
    return NextResponse.json({ error: "Profile not found" }, { status: 403 })
  }

  const scan = await getScanStatus(ctx.organizationId, id)

  if (!scan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  return NextResponse.json({
    status: scan.status,
    verdict: scan.verdict,
  })
}
