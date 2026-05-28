import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

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

  const supabase = createServiceClient()

  const { data: userRecord, error: userError } = await supabase
    .from("users")
    .select("organization_id")
    .eq("id", user.id)
    .single()

  if (userError || !userRecord) {
    return NextResponse.json({ error: "Profile not found" }, { status: 403 })
  }

  const { data: scan, error: scanError } = await supabase
    .from("scans")
    .select("status, verdict")
    .eq("id", id)
    .eq("organization_id", userRecord.organization_id)
    .single()

  if (scanError || !scan) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  return NextResponse.json({
    status: scan.status,
    verdict: scan.verdict,
  })
}
