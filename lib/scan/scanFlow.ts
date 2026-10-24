// Gate 007A - scan request orchestration for POST /api/scan.
// Pure module: type-only imports, no env vars, no I/O. Every effect (auth, org lookup, admission, persistence,
// providers, the guarded paid call, the clock) is injected by app/api/scan/route.ts, so the whole request flow is
// testable offline (scripts/rate-limit/test-scan-flow.ts).
//
// Order (fail closed at every step):
//   1. signed-in user (401)          2. organization context resolved server-side (403)
//   3. body, input type, input (400) 4. burst limit + shared admission (429 / 503, no scan row, no provider call)
//   5. scan row (500 if it cannot be created)
//   6. target normalization: no safe target -> complete/unknown, no provider call and no reservation
//   7. providers in parallel: unpaid ones directly; a paid one ONLY through callPaid (one execution-time
//      reservation, then at most one request). A refused reservation fails the scan with 503, no verdict.
//   8. scoring and persistence (201); any error after the scan row exists marks it failed (500).
// Deadline: if the provider phase (reservation RPC and provider requests) has not settled within
// PROVIDER_PHASE_DEADLINE_MS, the scan is marked failed and 504 is returned, well inside the route's
// maxDuration of 30 s, so a hung dependency cannot leave the scan in "processing".
import type { ScanProvider, ScanProviderResult } from "@/lib/scan/providers/types"
import type { LimitDecision } from "@/lib/security/rateLimit"
import type { GuardedOutcome } from "@/lib/security/providerBudget"
import type { EvidenceItem, VendorResultRow } from "@/lib/scan/scanHelpers"
import type { FastScanVerdict, RecordFastScanResultInput } from "@/src/server/scan/recordFastScanResult"

export const VALID_INPUT_TYPES = ["url", "domain", "email", "header", "signature", "batch"]
export const MAX_INPUT_LENGTH = 10000
export const PROVIDER_PHASE_DEADLINE_MS = 20000

export type ScanResponse = {
  status: number
  body: Record<string, unknown>
  headers?: Record<string, string>
}

export type PaidOutcome =
  | GuardedOutcome<ScanProviderResult>
  | { called: false; notConfigured: true; result: ScanProviderResult }

type ProviderEntry = { providerName: string; result: ScanProviderResult }

export type ScanFlowDeps = {
  getUser: () => Promise<{ id: string } | null>
  getOrgContext: (authUserId: string) => Promise<{ userId: string; organizationId: string } | null>
  readBody: () => Promise<unknown>   // throws on malformed JSON
  admit: (userId: string, inputType: string) => Promise<LimitDecision>
  createScan: (orgId: string, userId: string, inputType: string, rawInput: string) => Promise<string | null>
  markProcessing: (orgId: string, scanId: string) => Promise<void>
  normalizeTarget: (rawInput: string, inputType: string) => { ok: boolean; normalizedUrl?: string; reason?: string }
  getProviders: () => ScanProvider[]
  // The ONLY way a paid provider runs: one reservation funded by the admission, then at most one request.
  callPaid: (provider: ScanProvider, admissionId: string | undefined, url: string) => Promise<PaidOutcome>
  scoring: {
    confidence: (results: ProviderEntry[], totalProviders: number) => number
    risk: (results: ProviderEntry[], confidenceScore: number) => { riskScore: number; verdict: string }
    evidence: (scanId: string, orgId: string, providerName: string, result: ScanProviderResult) => EvidenceItem
    vendor: (scanId: string, orgId: string, providerName: string, result: ScanProviderResult) => VendorResultRow
  }
  persist: (input: RecordFastScanResultInput) => Promise<void>
  failScan: (orgId: string, scanId: string, durationMs: number) => Promise<void>
  retryHeaders: (decision: LimitDecision) => Record<string, string>
  now: () => number
  // A timer for the provider-phase deadline; clear() must stop it.
  timer: (ms: number) => { done: Promise<void>; clear: () => void }
  logError: (message: string, error: unknown) => void
}

const UNEXPECTED: ScanResponse = { status: 500, body: { error: "An unexpected error occurred. Please try again." } }

export async function handleScanRequest(deps: ScanFlowDeps): Promise<ScanResponse> {
  try {
    // 1. Authenticate user via Supabase Auth
    const user = await deps.getUser()
    if (!user) return { status: 401, body: { error: "Unauthorized" } }

    // 2. Resolve organization context server-side - never trust client
    const ctx = await deps.getOrgContext(user.id)
    if (!ctx) {
      return { status: 403, body: { error: "User profile not found. Please sign out and sign in again." } }
    }

    // 3. Parse and validate request body
    let body: { input?: unknown; input_type?: unknown }
    try {
      const parsed = await deps.readBody()
      body = parsed && typeof parsed === "object" ? (parsed as typeof body) : {}
    } catch {
      return { status: 400, body: { error: "Invalid request format." } }
    }

    const { input, input_type } = body

    // 4. Validate input_type
    if (typeof input_type !== "string" || !VALID_INPUT_TYPES.includes(input_type)) {
      return { status: 400, body: { error: "Invalid input type." } }
    }

    // 5. Validate raw_input
    if (!input || typeof input !== "string" || input.trim().length === 0) {
      return { status: 400, body: { error: "Please provide content to check." } }
    }

    const cleanInput = input.trim()

    if (cleanInput.length > MAX_INPUT_LENGTH) {
      return { status: 400, body: { error: `Input too long. Maximum ${MAX_INPUT_LENGTH} characters allowed.` } }
    }

    // 5b. Per-user burst limit, then the shared atomic admission. Rejected or unconfirmed admissions create no
    // scan row and make no provider call (fail closed).
    const admission = await deps.admit(ctx.userId, input_type)

    if (!admission.allowed) {
      const message =
        admission.status === 429
          ? "Scan limit reached. Please wait before scanning again."
          : "Scanning is temporarily unavailable. Please try again later."
      return { status: admission.status, body: { error: message, reason: admission.reason }, headers: deps.retryHeaders(admission) }
    }

    // 6. Create scan record
    const scanId = await deps.createScan(ctx.organizationId, ctx.userId, input_type, cleanInput)

    if (!scanId) return { status: 500, body: { error: "Failed to create scan. Please try again." } }

    return await runFastPath(deps, {
      scanId,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      rawInput: cleanInput,
      inputType: input_type,
      admissionId: admission.admissionId,
    })
  } catch (error) {
    deps.logError("Scan route error:", error)
    return UNEXPECTED
  }
}

// Every input type is scanned synchronously here. Email/header/signature/batch inputs use the first URL they
// contain; nothing is queued to Inngest.
async function runFastPath(
  deps: ScanFlowDeps,
  s: { scanId: string; userId: string; organizationId: string; rawInput: string; inputType: string; admissionId: string | undefined }
): Promise<ScanResponse> {
  const startTime = deps.now()

  try {
    await deps.markProcessing(s.organizationId, s.scanId)

    // SSRF validation
    const target = deps.normalizeTarget(s.rawInput, s.inputType)

    if (!target.ok || !target.normalizedUrl) {
      await deps.persist({
        userId: s.userId,
        organizationId: s.organizationId,
        scanId: s.scanId,
        status: "complete",
        verdict: "unknown",
        riskScore: 0,
        confidenceScore: 10,
        aiExplanation: null,
        recommendedAction: null,
        scanDurationMs: deps.now() - startTime,
        vendorResults: [],
        evidenceItems: [
          {
            signalType: "invalid_target",
            severity: "info",
            title: "Target could not be safely scanned",
            detail: target.reason ?? "Input could not be parsed into a safe scan target.",
            scoreImpact: 0,
          },
        ],
      })
      return { status: 201, body: { scan_id: s.scanId, status: "complete", verdict: "unknown" } }
    }

    // All enabled fast providers; every input type is checked as its normalized URL, so domain inputs like
    // "yahoo.com" are handled consistently.
    const providers = deps.getProviders()
    const providerInput = target.normalizedUrl
    const providerInputType = "url" as const

    // Unpaid providers run directly. A paid provider runs ONLY through callPaid: one execution-time reservation,
    // then at most one request. A refused or unconfirmed reservation makes no request and fails the whole scan
    // with 503 - an incomplete check must never produce a verdict.
    const budget: { refused: { status: 503; reason: string; retryAfterSeconds: number } | null } = { refused: null }
    const phase = Promise.allSettled(
      providers.map(async (provider) => {
        if (provider.paid !== true) return provider.run(providerInput, providerInputType)
        const outcome = await deps.callPaid(provider, s.admissionId, providerInput)
        if ("result" in outcome) return outcome.result
        budget.refused = outcome.decision
        throw new Error("Provider budget not granted")
      })
    )
    const deadline = deps.timer(PROVIDER_PHASE_DEADLINE_MS)
    const raced = await Promise.race([phase, deadline.done.then(() => "timed_out" as const)])
    deadline.clear()

    if (raced === "timed_out") {
      await deps.failScan(s.organizationId, s.scanId, deps.now() - startTime)
      return {
        status: 504,
        body: { error: "The check took too long. Please try again.", reason: "scan_timeout", scan_id: s.scanId },
        headers: { "Cache-Control": "no-store" },
      }
    }
    const providerResults = raced

    if (budget.refused) {
      await deps.failScan(s.organizationId, s.scanId, deps.now() - startTime)
      const refused = budget.refused
      return {
        status: 503,
        body: { error: "Scanning is temporarily unavailable. Please try again later.", reason: refused.reason, scan_id: s.scanId },
        headers: deps.retryHeaders({ allowed: false, status: 503, reason: refused.reason, retryAfterSeconds: refused.retryAfterSeconds }),
      }
    }

    // Collect results with provider names
    const results: ProviderEntry[] = providers.map((provider, i) => {
      const settled = providerResults[i]
      return {
        providerName: provider.name,
        result:
          settled.status === "fulfilled"
            ? settled.value
            : {
                verdict: "error" as const,
                error: "Provider threw unexpectedly",
                scoreImpact: 0,
                confidenceImpact: -10,
                evidenceTitle: `${provider.displayName} check failed`,
                evidenceDetail: "An unexpected error occurred.",
                evidenceSeverity: "info" as const,
                rawResponse: null,
                responseTimeMs: 0,
              },
      }
    })

    // Calculate scores from all provider results
    const confidenceScore = deps.scoring.confidence(results, providers.length)
    const { riskScore, verdict } = deps.scoring.risk(results, confidenceScore)

    const scanDurationMs = deps.now() - startTime

    const evidenceRows = results.map(({ providerName, result }) => deps.scoring.evidence(s.scanId, s.organizationId, providerName, result))
    const vendorRows = results.map(({ providerName, result }) => deps.scoring.vendor(s.scanId, s.organizationId, providerName, result))

    const finalVerdict: FastScanVerdict =
      verdict === "safe" || verdict === "suspicious" || verdict === "dangerous" || verdict === "unknown"
        ? verdict
        : "unknown"

    await deps.persist({
      userId: s.userId,
      organizationId: s.organizationId,
      scanId: s.scanId,
      status: "complete",
      verdict: finalVerdict,
      riskScore,
      confidenceScore,
      aiExplanation: null,
      recommendedAction: null,
      scanDurationMs,
      vendorResults: vendorRows.map((row) => ({
        vendorName: row.vendor_name,
        verdict: row.verdict,
        rawResponse: row.raw_response,
        errorMessage: row.error_message,
        responseTimeMs: row.response_time_ms,
      })),
      evidenceItems: evidenceRows.map((row) => ({
        signalType: row.signal_type,
        severity: row.severity,
        title: row.title,
        detail: row.detail,
        scoreImpact: row.score_impact,
      })),
    })

    return { status: 201, body: { scan_id: s.scanId, status: "complete", verdict: finalVerdict } }
  } catch (error) {
    deps.logError("Fast path error:", error)
    try {
      await deps.failScan(s.organizationId, s.scanId, deps.now() - startTime)
    } catch (failError) {
      deps.logError("Could not mark scan failed:", failError)
    }
    return UNEXPECTED
  }
}
