import { auth } from "@clerk/nextjs/server"
import { NextResponse, type NextRequest } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

export async function POST(request: NextRequest) {
  try {
    const { isAuthenticated, userId } = await auth()

    if (!isAuthenticated || !userId) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      )
    }

    let body: { full_name?: string; organization_name?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: "Invalid request format." },
        { status: 400 }
      )
    }

    const { full_name, organization_name } = body

    if (!full_name || typeof full_name !== "string" || full_name.trim().length === 0) {
      return NextResponse.json(
        { error: "Full name is required." },
        { status: 400 }
      )
    }

    if (!organization_name || typeof organization_name !== "string" || organization_name.trim().length === 0) {
      return NextResponse.json(
        { error: "Organization name is required." },
        { status: 400 }
      )
    }

    const supabase = createServiceClient()

    const { data: existingUser } = await supabase
      .from("users")
      .select("id")
      .eq("clerk_user_id", userId)
      .single()

    if (existingUser) {
      return NextResponse.json(
        { error: "User already onboarded." },
        { status: 409 }
      )
    }

    const slug = organization_name.trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")

    const { data: org, error: orgError } = await supabase
      .from("organizations")
      .insert({
        name: organization_name.trim(),
        slug: `${slug}-${Date.now()}`,
        plan: "free",
        scan_count_this_month: 0,
      })
      .select("id")
      .single()

    if (orgError || !org) {
      console.error("Org insert error:", orgError)
      return NextResponse.json(
        { error: "Failed to create organization. Please try again." },
        { status: 500 }
      )
    }

    const { error: userError } = await supabase
      .from("users")
      .insert({
        organization_id: org.id,
        clerk_user_id: userId,
        full_name: full_name.trim(),
        role: "admin",
      })

    if (userError) {
      console.error("User insert error:", userError)
      return NextResponse.json(
        { error: "Failed to create user profile. Please try again." },
        { status: 500 }
      )
    }

    return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error) {
    console.error("Onboarding error:", error)
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 })
}

