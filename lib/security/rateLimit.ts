// Gate 007A - scanner and login rate limiting.
// Pure module: no imports, no env vars, no I/O. The admission call and the clock are injected, so the logic is
// testable offline (scripts/rate-limit/test-rate-limit.ts).
//
// Layers, cheapest first:
//   1. Per-user burst limit, in memory (per instance): 5 scans/minute.
//   2. Shared, atomic scan admission in Supabase Postgres (public.cbc_admit_scan, called with the user's own
//      session; infra/supabase/migrations/001_scan_admission.sql). Rolling 24 hours: 500 global, 200 per
//      organization, 50 per user. Paid Web Risk calls are budgeted separately at execution time
//      (lib/security/providerBudget.ts: one reservation per admission). The database is the authority for these numbers.
//   3. Login attempts per client IP and per email, in memory (per instance), applied by POST /api/auth/login,
//      the only sign-in path the login page uses (lib/security/loginFlow.ts). Direct calls to Supabase Auth with
//      the public anon key bypass it; only Supabase Auth's own limits apply to those.
// An admission that cannot be confirmed fails closed: no scan row and no provider call.

export const SCAN_BURST_PER_USER_PER_MINUTE = 5

// Informational mirror of the database limits (the SQL function enforces them).
export const ADMISSION_LIMITS_24H = { global: 500, perOrganization: 200, perUser: 50, maxWebRiskCalls: 1000 }

export const LOGIN_LIMITS = {
  perIpPerWindow: 10,
  perEmailPerWindow: 5,
  windowMs: 15 * 60 * 1000,
}

export const MINUTE_MS = 60 * 1000
export const MAX_TRACKED_KEYS = 10000
export const MAX_KEY_LENGTH = 320 // longest valid email address; longer keys are truncated
const SWEEP_INTERVAL_MS = 1000
export const CAPACITY_REASON = "rate_limiter_at_capacity"

export type LimitDecision =
  | { allowed: true; admissionId?: string }
  | { allowed: false; status: 429 | 503; reason: string; retryAfterSeconds: number }

export type SlidingWindowLimiter = {
  hit: (key: string) => LimitDecision
  reset: () => void
  trackedKeys: () => number
  retainedTimestamps: () => number
}

// In-memory sliding-window limiter. Every call counts as an attempt (also rejected ones), so hammering a
// limited key keeps it limited.
//
// Memory is bounded on both axes:
//   - per key, at most `limit` timestamps are kept (the most recent attempts, rejected ones included). That is
//     all the decision needs: a key is allowed while fewer than `limit` attempts fall inside the window, and
//     the oldest retained attempt tells when the next one becomes possible.
//   - at most `maxTrackedKeys` keys (default 10000), each truncated to MAX_KEY_LENGTH characters (truncation
//     can only merge keys, which makes limiting stricter, never looser).
// At capacity (after sweeping expired keys, at most once per second) a NEW key is refused with
// "rate_limiter_at_capacity" (fail closed). Keys already tracked keep being evaluated normally, and nothing is
// ever evicted early: evicting a live key would reset its counter and silently disable its limit.
export function createSlidingWindowLimiter(options: {
  limit: number
  windowMs: number
  reason: string
  now?: () => number
  maxTrackedKeys?: number
}): SlidingWindowLimiter {
  const now = options.now ?? (() => Date.now())
  const maxKeys = options.maxTrackedKeys ?? MAX_TRACKED_KEYS
  const limit = Math.max(1, Math.floor(options.limit))
  let hits = new Map<string, number[]>()
  let lastSweep = Number.NEGATIVE_INFINITY

  function sweep(t: number) {
    if (t - lastSweep < SWEEP_INTERVAL_MS) return
    lastSweep = t
    for (const [k, v] of hits) {
      if (v[v.length - 1] <= t - options.windowMs) hits.delete(k)
    }
  }

  return {
    hit(rawKey: string): LimitDecision {
      const t = now()
      const key = String(rawKey).slice(0, MAX_KEY_LENGTH)
      let recent = hits.get(key)
      if (!recent) {
        if (hits.size >= maxKeys) sweep(t)
        if (hits.size >= maxKeys) {
          return { allowed: false, status: 429, reason: CAPACITY_REASON, retryAfterSeconds: Math.max(1, Math.ceil(SWEEP_INTERVAL_MS / 1000)) }
        }
        recent = []
      }
      const live = recent.filter((x) => x > t - options.windowMs)
      const allowed = live.length < limit
      live.push(t)
      if (live.length > limit) live.splice(0, live.length - limit)
      hits.set(key, live)
      if (allowed) return { allowed: true }
      const retryAfterSeconds = Math.max(1, Math.ceil((live[0] + options.windowMs - t) / 1000))
      return { allowed: false, status: 429, reason: options.reason, retryAfterSeconds }
    },
    reset() {
      hits = new Map()
      lastSweep = Number.NEGATIVE_INFINITY
    },
    trackedKeys() {
      return hits.size
    },
    retainedTimestamps() {
      let n = 0
      for (const v of hits.values()) n += v.length
      return n
    },
  }
}

export type AdmissionRow = {
  admitted: boolean
  reason: string
  retry_after_seconds: number
  provider_calls_reserved: number
  admission_id: number | string | null
}

// Maps the result of the cbc_admit_scan RPC to a decision. Anything unexpected fails closed (503).
export function interpretAdmission(data: unknown, error: unknown): LimitDecision {
  if (error) return { allowed: false, status: 503, reason: "admission_unavailable", retryAfterSeconds: 60 }
  const row = (Array.isArray(data) ? data[0] : data) as Partial<AdmissionRow> | null | undefined
  if (!row || typeof row !== "object" || typeof row.admitted !== "boolean" || typeof row.reason !== "string") {
    return { allowed: false, status: 503, reason: "admission_unavailable", retryAfterSeconds: 60 }
  }
  if (row.admitted === true) {
    if (row.reason !== "admitted" || row.admission_id === null || row.admission_id === undefined) {
      return { allowed: false, status: 503, reason: "admission_unavailable", retryAfterSeconds: 60 }
    }
    return { allowed: true, admissionId: String(row.admission_id) }   // funds at most one paid provider reservation
  }
  const retry = Number.isFinite(row.retry_after_seconds) && (row.retry_after_seconds as number) > 0 ? Math.ceil(row.retry_after_seconds as number) : 60
  switch (row.reason) {
    case "user_daily_limit":
    case "organization_daily_limit":
      return { allowed: false, status: 429, reason: row.reason, retryAfterSeconds: retry }
    case "global_scan_capacity_reached":
      return { allowed: false, status: 503, reason: row.reason, retryAfterSeconds: retry }
    default:
      // unauthenticated, no_organization, invalid_input_type or anything unknown: never admitted
      return { allowed: false, status: 503, reason: "admission_unavailable", retryAfterSeconds: 60 }
  }
}

// Burst first (no database work), then the shared admission. A burst rejection consumes no admission.
export async function admitScan(args: {
  userId: string
  inputType: string
  burst: SlidingWindowLimiter
  callAdmission: (inputType: string) => Promise<{ data: unknown; error: unknown }>
}): Promise<LimitDecision> {
  const b = args.burst.hit(args.userId)
  if (!b.allowed) return b
  let result: { data: unknown; error: unknown }
  try {
    result = await args.callAdmission(args.inputType)
  } catch (e) {
    result = { data: null, error: e ?? "admission call threw" }
  }
  return interpretAdmission(result.data, result.error)
}

// Client IP for login limiting. The hosting proxy (Azure Container Apps ingress; Vercel today) appends or sets
// the real client address as the LAST X-Forwarded-For entry; earlier entries can be forged by the client.
export function clientIpFromForwardedFor(headerValue: string | null): string {
  if (!headerValue) return "unknown"
  const parts = headerValue.split(",").map((p) => p.trim()).filter(Boolean)
  return parts.length ? parts[parts.length - 1].toLowerCase() : "unknown"
}

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function checkLoginAllowed(args: {
  ip: string
  email: string
  byIp: SlidingWindowLimiter
  byEmail: SlidingWindowLimiter
}): LimitDecision {
  // IP first. A request the IP limiter rejects returns immediately and never touches the email limiter: no
  // new email bucket, no change to an existing counter or its expiry. Otherwise one blocked IP could fill the
  // email limiter's key capacity (or keep a victim's email locked out) at no cost. Each IP can therefore reach
  // the email limiter at most LOGIN_LIMITS.perIpPerWindow times per window.
  const ipDecision = args.byIp.hit(args.ip)
  if (!ipDecision.allowed) return ipDecision
  const emailDecision = args.byEmail.hit(normalizeLoginEmail(args.email))
  if (!emailDecision.allowed) return emailDecision
  return { allowed: true }
}

// Process-wide limiters (one set per server instance).
export const scanBurstLimiter = createSlidingWindowLimiter({
  limit: SCAN_BURST_PER_USER_PER_MINUTE,
  windowMs: MINUTE_MS,
  reason: "user_burst_limit",
})
export const loginIpLimiter = createSlidingWindowLimiter({
  limit: LOGIN_LIMITS.perIpPerWindow,
  windowMs: LOGIN_LIMITS.windowMs,
  reason: "login_ip_limit",
})
export const loginEmailLimiter = createSlidingWindowLimiter({
  limit: LOGIN_LIMITS.perEmailPerWindow,
  windowMs: LOGIN_LIMITS.windowMs,
  reason: "login_email_limit",
})

export function rateLimitHeaders(decision: LimitDecision): Record<string, string> {
  if (decision.allowed) return {}
  return { "Retry-After": String(decision.retryAfterSeconds), "Cache-Control": "no-store" }
}
