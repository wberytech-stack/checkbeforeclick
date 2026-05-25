import { createClient } from "@/lib/supabase/server"
import { inngest } from "@/inngest/client"
import { NextResponse } from "next/server"
import { cookies } from "next/headers"

const VALID_INPUT_TYPES = ["url", "domain", "email", "header", "signature", "batch"]
const MAX_INPUT_LENGTH = 10000

export async function POST(request: Request) {
  try {
    // DIAG: check cookies
    const cookieStore = await cookies()
    const allCookies = cookieStore.getAll()
    const cookieNames = allCookies.map(c => c.name)
    const hasAuthCookie = cookieNames.some(n => n.includes("auth-token"))
    console.log("[DIAG] cookie names:", cookieNames)
    console.log("[DIAG] hasAuthCookie:", hasAuthCookie)

    // 1. Authenticate user server-side
    const supabase = await createClient()
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    console.log("[DIAG] getUserOk:", !authError)
    console.log("[DIAG] userIdPresent:", !!user)
    if (authError) console.log("[DIAG] authError:", authError.message)

    if (authError || !user) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // 2. Get organization_id from database - never trust client
    const { data: userRecord, error: userError } = await supabase
      .from("users")
      .select("organization_id, role")
      .eq("id", user.id)
      .single()
    console.log("[DIAG] orgLookupOk:", !userError && !!userRecord)

    if (userError || !userRecord) {
      return NextResponse.json(
        { error: "User profile not found. Please contact support." },
        { status: 403 }
      )
    }

    // 3. Parse and validate request body
    let body: { input?: string; input_type?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: "Invalid request format." },
        { status: 400 }
      )
    }

    const { input, input_type } = body

    // 4. Validate input_type
    if (!input_type || !VALID_INPUT_TYPES.includes(input_type)) {
      return NextResponse.json(
        { error: "Invalid input type." },
        { status: 400 }
      )
    }

    // 5. Validate raw_input
    if (!input || typeof input !== "string" || input.trim().length === 0) {
      return NextResponse.json(
        { error: "Please provide content to check." },
        { status: 400 }
      )
    }

    if (input.length > MAX_INPUT_LENGTH) {
      return NextResponse.json(
        { error: `Input too long. Maximum ${MAX_INPUT_LENGTH} characters allowed.` },
        { status: 400 }
      )
    }

    // 6. Create scan record
    const { data: scan, error: scanError } = await supabase
      .from("scans")
      .insert({
        organization_id: userRecord.organization_id,
        user_id: user.id,
        input_type: input_type,
        raw_input: input.trim(),
        status: "pending",
      })
      .select("id")
      .single()

    if (scanError || !scan) {
      console.error("Scan insert error:", scanError)
      return NextResponse.json(
        { error: "Failed to create scan. Please try again." },
        { status: 500 }
      )
    }

    // 7. Trigger Inngest background job
    await inngest.send({
      name: "scan/requested",
      data: {
        scan_id: scan.id,
      },
    })

    return NextResponse.json({ scan_id: scan.id }, { status: 201 })
  } catch (error) {
    console.error("Scan route error:", error)
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 })
}

