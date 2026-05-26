import { auth } from "@clerk/nextjs/server"
import { inngest } from "@/inngest/client"
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

const VALID_INPUT_TYPES = ["url", "domain", "email", "header", "signature", "batch"]
const MAX_INPUT_LENGTH = 10000

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate user via Clerk
    const { isAuthenticated, userId } = await auth()

    if (!isAuthenticated || !userId) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    // 2. Get organization_id from database using Clerk user ID
    // Never trust client-provided user_id or organization_id
    const supabase = createServiceClient()
    const { data: userRecord, error: userError } = await supabase
      .from("users")
      .select("id, organization_id, role")
      .eq("clerk_user_id", userId)
      .single()

    if (userError || !userRecord) {
      return NextResponse.json(
        { error: "User profile not found. Please complete onboarding." },
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
        user_id: userRecord.id,
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

    // 7. Trigger Inngest background job - send only scan_id
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


