import { createServerClient } from "@supabase/ssr"
import { type NextRequest, NextResponse } from "next/server"
import {
  checkLoginAllowed,
  clientIpFromForwardedFor,
  loginEmailLimiter,
  loginIpLimiter,
  rateLimitHeaders,
} from "@/lib/security/rateLimit"

export async function POST(request: NextRequest) {
  try {
    let body: { email?: string; password?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: "Invalid request format." },
        { status: 400 }
      )
    }

    const { email, password } = body

    if (!email || typeof email !== "string" || !password || typeof password !== "string") {
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 }
      )
    }

    // Gate 007A: per-IP and per-email attempt limits before Supabase is called (Supabase sees this server's
    // address, not the user's, so its own per-IP limits cannot tell users apart).
    const limit = checkLoginAllowed({
      ip: clientIpFromForwardedFor(request.headers.get("x-forwarded-for")),
      email,
      byIp: loginIpLimiter,
      byEmail: loginEmailLimiter,
    })

    if (!limit.allowed) {
      return NextResponse.json(
        { error: "Too many sign-in attempts. Please wait and try again." },
        { status: 429, headers: rateLimitHeaders(limit) }
      )
    }

    const response = NextResponse.json(
      { ok: true, target: "/dashboard" },
      { status: 200 }
    )
    response.headers.set("Cache-Control", "no-store, private")

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set(name, value, options)
            })
          },
        },
      }
    )

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) {
      return NextResponse.json(
        { error: "Invalid email or password." },
        { status: 401 }
      )
    }

    return response
  } catch {
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 })
}
