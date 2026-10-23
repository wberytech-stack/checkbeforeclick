import "server-only"
import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { normalizeScanTarget } from "@/lib/security/urlSafety"
import { getFastProviders } from "@/lib/scan/providers"
import {
  calculateRiskScoreFromProviders,
  calculateConfidenceFromProviders,
  buildEvidenceItem,
  buildVendorResultRow,
} from "@/lib/scan/scanHelpers"
import {
  getUserOrgContext,
  createScan,
  markScanProcessing,
  completeScan,
  failScan,
  insertEvidenceItems,
  insertVendorResults,
} from "@/lib/data"
import {
  recordFastScanResult,
  type FastScanVerdict,
  type RecordFastScanResultInput,
} from "@/src/server/scan/recordFastScanResult"
import { isFastScanPersistenceHelperEnabled } from "@/src/server/scan/fastScanPersistenceFlag"
import { admitScan, rateLimitHeaders, scanBurstLimiter } from "@/lib/security/rateLimit"
import { callWebRiskGuarded, type WebRiskReserve } from "@/lib/scan/providers/googleWebRisk"

// Gate 007A: every scan, including email/header/signature/batch, is processed synchronously in this request so
// that paid Web Risk calls happen only here, under an execution-time reservation. Providers time out at 7 s and
// run in parallel; 30 s leaves room for the sequential Supabase calls.
export const maxDuration = 30

const VALID_INPUT_TYPES = ["url", "domain", "email", "header", "signature", "batch"]
const MAX_INPUT_LENGTH = 10000

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate user via Supabase Auth
    const authClient = await createClient()
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 2. Resolve organization context server-side - never trust client
    const ctx = await getUserOrgContext(user.id)

    if (!ctx) {
      return NextResponse.json(
        { error: "User profile not found. Please sign out and sign in again." },
        { status: 403 }
      )
    }

    // 3. Parse and validate request body
    let body: { input?: string; input_type?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid request format." }, { status: 400 })
    }

    const { input, input_type } = body

    // 4. Validate input_type
    if (!input_type || !VALID_INPUT_TYPES.includes(input_type)) {
      return NextResponse.json({ error: "Invalid input type." }, { status: 400 })
    }

    // 5. Validate raw_input
    if (!input || typeof input !== "string" || input.trim().length === 0) {
      return NextResponse.json({ error: "Please provide content to check." }, { status: 400 })
    }

    const cleanInput = input.trim()

    if (cleanInput.length > MAX_INPUT_LENGTH) {
      return NextResponse.json(
        { error: `Input too long. Maximum ${MAX_INPUT_LENGTH} characters allowed.` },
        { status: 400 }
      )
    }

    // 5b. Gate 007A: per-user burst limit, then the shared atomic admission (cbc_admit_scan), called with the
    // user's own session - never the service-role key. Rejected or unconfirmed admissions create no scan row and
    // make no provider call (fail closed).
    const admission = await admitScan({
      userId: ctx.userId,
      inputType: input_type,
      burst: scanBurstLimiter,
      callAdmission: async (inputType) => {
        const { data, error } = await authClient.rpc("cbc_admit_scan", { p_input_type: inputType })
        return { data, error }
      },
    })

    if (!admission.allowed) {
      const message =
        admission.status === 429
          ? "Scan limit reached. Please wait before scanning again."
          : "Scanning is temporarily unavailable. Please try again later."
      return NextResponse.json(
        { error: message, reason: admission.reason },
        { status: admission.status, headers: rateLimitHeaders(admission) }
      )
    }

    // 6. Create scan record
    const scanId = await createScan(ctx.organizationId, ctx.userId, input_type, cleanInput)

    if (!scanId) {
      return NextResponse.json(
        { error: "Failed to create scan. Please try again." },
        { status: 500 }
      )
    }

    // 7. Every input type is scanned synchronously here (Gate 007A). Email/header/signature/batch inputs use the
    // first URL they contain, exactly as the background worker used to; nothing is queued to Inngest any more.
    // The reservation for the paid Web Risk call is made with the user's own session, never the service role.
    const reserve: WebRiskReserve = async (provider, admissionId) => {
      const { data, error } = await authClient.rpc("cbc_reserve_provider_call", {
        p_provider: provider,
        p_admission_id: Number(admissionId),
      })
      return { data, error }
    }

    return await runFastPath({
      scan_id: scanId,
      user_id: ctx.userId,
      organization_id: ctx.organizationId,
      raw_input: cleanInput,
      input_type,
      admission_id: admission.admissionId,
      reserve,
    })

  } catch (error) {
    console.error("Scan route error:", error)
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    )
  }
}

// Persists a fast scan's terminal result.
// Gate 003T fail-safe: recordFastScanResult (CBC_DATABASE_URL, migration 004)
// runs only when explicitly enabled. By default the pre-Gate 003Q writes are
// used and the pg pool is never touched. See Gate 003S approval B.
async function persistFastScanResult(input: RecordFastScanResultInput) {
  if (isFastScanPersistenceHelperEnabled()) {
    await recordFastScanResult(input)
    return
  }

  await insertEvidenceItems(
    input.organizationId,
    input.evidenceItems.map((item) => ({
      scan_id: input.scanId,
      signal_type: item.signalType,
      severity: item.severity,
      title: item.title,
      detail: item.detail ?? null,
      score_impact: item.scoreImpact ?? 0,
    }))
  )

  await insertVendorResults(
    input.organizationId,
    input.vendorResults.map((vendor) => ({
      scan_id: input.scanId,
      vendor_name: vendor.vendorName,
      verdict: vendor.verdict ?? null,
      raw_response: vendor.rawResponse ?? null,
      error_message: vendor.errorMessage ?? null,
      response_time_ms: vendor.responseTimeMs ?? null,
    }))
  )

  await completeScan(input.organizationId, input.scanId, {
    riskScore: input.riskScore ?? 0,
    confidenceScore: input.confidenceScore ?? 0,
    verdict: input.verdict ?? "unknown",
    durationMs: input.scanDurationMs ?? 0,
  })
}

// Fast synchronous path - runs all enabled fast providers in parallel
async function runFastPath({
  scan_id,
  user_id,
  organization_id,
  raw_input,
  input_type,
  admission_id,
  reserve,
}: {
  scan_id: string
  user_id: string
  organization_id: string
  raw_input: string
  input_type: string
  admission_id: string | undefined
  reserve: WebRiskReserve
}) {
  const startTime = Date.now()

  try {
    await markScanProcessing(organization_id, scan_id)

    // SSRF validation
    const target = normalizeScanTarget(raw_input, input_type)

    if (!target.ok) {
      await persistFastScanResult({
        userId: user_id,
        organizationId: organization_id,
        scanId: scan_id,
        status: "complete",
        verdict: "unknown",
        riskScore: 0,
        confidenceScore: 10,
        aiExplanation: null,
        recommendedAction: null,
        scanDurationMs: Date.now() - startTime,
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

      return NextResponse.json(
        { scan_id, status: "complete", verdict: "unknown" },
        { status: 201 }
      )
    }

    // All enabled fast providers; every input type is checked as its normalized URL
    const providers = getFastProviders("url")

    // Run all providers in parallel - one failure never blocks others
    // Always use normalized URL and "url" type after normalization
    // This ensures domain inputs like "yahoo.com" are handled consistently
    const providerInput = target.normalizedUrl!
    const providerInputType = "url" as const

    // Unpaid providers run directly. The paid provider (Google Web Risk) runs ONLY through callWebRiskGuarded:
    // one execution-time reservation, then at most one request. A refused or unconfirmed reservation makes no
    // request and fails the whole scan with 503 - an incomplete check must never produce a verdict.
    const budget: { refused: { status: 503; reason: string; retryAfterSeconds: number } | null } = { refused: null }
    const providerResults = await Promise.allSettled(
      providers.map(async (provider) => {
        if (provider.paid !== true) return provider.run(providerInput, providerInputType)
        if (provider.name !== "google_web_risk") throw new Error("No guarded entry point for this paid provider")
        const outcome = await callWebRiskGuarded({ admissionId: admission_id, url: providerInput, reserve })
        if ("result" in outcome) return outcome.result
        budget.refused = outcome.decision
        throw new Error("Provider budget not granted")
      })
    )

    if (budget.refused) {
      await failScan(organization_id, scan_id, Date.now() - startTime)
      const refused = budget.refused
      return NextResponse.json(
        { error: "Scanning is temporarily unavailable. Please try again later.", reason: refused.reason, scan_id },
        { status: 503, headers: rateLimitHeaders({ allowed: false, status: 503, reason: refused.reason, retryAfterSeconds: refused.retryAfterSeconds }) }
      )
    }

    // Collect results with provider names
    const results = providers.map((provider, i) => ({
      providerName: provider.name,
      result:
        providerResults[i].status === "fulfilled"
          ? providerResults[i].value
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
    }))

    // Calculate scores from all provider results
    const confidenceScore = calculateConfidenceFromProviders(results, providers.length)
    const { riskScore, verdict } = calculateRiskScoreFromProviders(results, confidenceScore)

    const scanDurationMs = Date.now() - startTime

    const evidenceRows = results.map(({ providerName, result }) =>
      buildEvidenceItem(scan_id, organization_id, providerName, result)
    )

    const vendorRows = results.map(({ providerName, result }) =>
      buildVendorResultRow(scan_id, organization_id, providerName, result)
    )

    const finalVerdict: FastScanVerdict =
      verdict === "safe" ||
      verdict === "suspicious" ||
      verdict === "dangerous" ||
      verdict === "unknown"
        ? verdict
        : "unknown"

    await persistFastScanResult({
      userId: user_id,
      organizationId: organization_id,
      scanId: scan_id,
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

    return NextResponse.json(
      { scan_id, status: "complete", verdict: finalVerdict },
      { status: 201 }
    )

  } catch (error) {
    console.error("Fast path error:", error)

    await failScan(organization_id, scan_id, Date.now() - startTime)

    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 })
}
