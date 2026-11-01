// Gate 007A - password sign-in request flow for POST /api/auth/login (the only sign-in path the app's UI uses).
// Pure module: type-only imports, no env vars, no I/O. The limiters, the Supabase sign-in call and the client
// address are injected by app/api/auth/login/route.ts, so the flow is testable offline
// (scripts/rate-limit/test-login-flow.ts).
//
// What this does and does NOT protect:
//   - It throttles every sign-in made through the CBC login page (10 attempts per client IP and 5 per email per
//     15 minutes), before Supabase is called.
//   - The limiters are in memory, per server instance: with several serverless instances an attacker can get
//     more attempts than the nominal limit. They are a best-effort first layer, not a global cap.
//   - Supabase Auth itself stays reachable directly with the public anon key (POST /auth/v1/token). Requests that
//     bypass this route are limited only by Supabase Auth's own per-IP rate limits and CAPTCHA settings, which are
//     project configuration outside this repository.
import type { LimitDecision } from "@/lib/security/rateLimit"

export type LoginResponse = {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
}

export type LoginFlowDeps = {
  readBody: () => Promise<unknown>   // throws on malformed JSON
  checkAllowed: (email: string) => LimitDecision
  // Resolves true only when Supabase accepted the credentials and the session cookies were set on the response.
  signIn: (email: string, password: string) => Promise<boolean>
  retryHeaders: (decision: LimitDecision) => Record<string, string>
}

export const MAX_LOGIN_EMAIL_LENGTH = 320
export const MAX_LOGIN_PASSWORD_LENGTH = 1024

const NO_STORE = { "Cache-Control": "no-store, private" }

export async function handleLoginRequest(deps: LoginFlowDeps): Promise<LoginResponse> {
  try {
    let body: { email?: unknown; password?: unknown }
    try {
      const parsed = await deps.readBody()
      body = parsed && typeof parsed === "object" ? (parsed as typeof body) : {}
    } catch {
      return { status: 400, body: { error: "Invalid request format." }, headers: NO_STORE }
    }

    const email = typeof body.email === "string" ? body.email.trim() : ""
    const password = typeof body.password === "string" ? body.password : ""

    if (!email || !password || email.length > MAX_LOGIN_EMAIL_LENGTH || password.length > MAX_LOGIN_PASSWORD_LENGTH) {
      return { status: 400, body: { error: "Email and password are required." }, headers: NO_STORE }
    }

    // Per-IP and per-email attempt limits before Supabase is called (Supabase sees this server's address, not
    // the user's, so its own per-IP limits cannot tell this route's users apart).
    const limit = deps.checkAllowed(email)
    if (!limit.allowed) {
      return {
        status: 429,
        body: { error: "Too many sign-in attempts. Please wait and try again.", retry_after_seconds: limit.retryAfterSeconds },
        headers: { ...NO_STORE, ...deps.retryHeaders(limit) },
      }
    }

    const ok = await deps.signIn(email, password)
    if (!ok) return { status: 401, body: { error: "Invalid email or password." }, headers: NO_STORE }

    return { status: 200, body: { ok: true }, headers: NO_STORE }
  } catch {
    return { status: 500, body: { error: "An unexpected error occurred. Please try again." }, headers: NO_STORE }
  }
}

// Post-login destination from the ?next= query parameter. Only same-site absolute paths are accepted
// ("/dashboard", "/scan/abc?x=1"); anything else (other origins, "//host", "/\host", schemes, control
// characters) falls back to /dashboard, so the login page cannot be used as an open redirect.
export function safeNextPath(raw: string | null | undefined): string {
  const fallback = "/dashboard"
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048) return fallback
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return fallback
  if (/[\u0000-\u001f\u007f\\]/.test(raw)) return fallback
  return raw
}
