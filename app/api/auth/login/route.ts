import { createServerClient } from "@supabase/ssr"
import { type NextRequest, NextResponse } from "next/server"
import {
  checkLoginAllowed,
  clientIpFromForwardedFor,
  loginEmailLimiter,
  loginIpLimiter,
  rateLimitHeaders,
} from "@/lib/security/rateLimit"
import { handleLoginRequest } from "@/lib/security/loginFlow"

// Gate 007A: the login page signs in through this route, so every UI sign-in passes the attempt limits first.
// The request flow lives in lib/security/loginFlow.ts (pure, tested offline); this route only wires the effects.
// Session cookies set by Supabase are collected here and copied onto the final response only on success.
export async function POST(request: NextRequest) {
  const sessionCookies: { name: string; value: string; options: Parameters<NextResponse["cookies"]["set"]>[2] }[] = []

  const result = await handleLoginRequest({
    readBody: () => request.json(),
    checkAllowed: (email) =>
      checkLoginAllowed({
        ip: clientIpFromForwardedFor(request.headers.get("x-forwarded-for")),
        email,
        byIp: loginIpLimiter,
        byEmail: loginEmailLimiter,
      }),
    signIn: async (email, password) => {
      const supabase = createServerClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
        {
          cookies: {
            getAll() {
              return request.cookies.getAll()
            },
            setAll(cookiesToSet) {
              cookiesToSet.forEach((c) => sessionCookies.push(c))
            },
          },
        }
      )
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      return !error
    },
    retryHeaders: rateLimitHeaders,
  })

  const response = NextResponse.json(result.body, { status: result.status, headers: result.headers })
  if (result.status === 200) {
    sessionCookies.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
  }
  return response
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed." }, { status: 405 })
}
