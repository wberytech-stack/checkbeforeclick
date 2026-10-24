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
  type RecordFastScanResultInput,
} from "@/src/server/scan/recordFastScanResult"
import { isFastScanPersistenceHelperEnabled } from "@/src/server/scan/fastScanPersistenceFlag"
import { admitScan, rateLimitHeaders, scanBurstLimiter } from "@/lib/security/rateLimit"
import { callWebRiskGuarded } from "@/lib/scan/providers/googleWebRisk"
import { handleScanRequest } from "@/lib/scan/scanFlow"

// Gate 007A: every scan, including email/header/signature/batch, is processed synchronously in this request so
// that paid Web Risk calls happen only here, under an execution-time reservation. Providers time out at 7 s and
// run in parallel; 30 s leaves room for the sequential Supabase calls.
export const maxDuration = 30

// The request flow lives in lib/scan/scanFlow.ts (pure, tested offline). This route only wires the real effects.
// Admission and reservation RPCs use the signed-in user's own session (session()), never the service role.
export async function POST(request: NextRequest) {
  // Created lazily inside the flow, so a failure here is a JSON 500 like any other unexpected error.
  let authClient: Awaited<ReturnType<typeof createClient>> | null = null
  const session = async () => (authClient ??= await createClient())

  const result = await handleScanRequest({
    getUser: async () => {
      const { data: { user }, error } = await (await session()).auth.getUser()
      return error || !user ? null : { id: user.id }
    },
    getOrgContext: (authUserId) => getUserOrgContext(authUserId),
    readBody: () => request.json(),
    admit: (userId, inputType) =>
      admitScan({
        userId,
        inputType,
        burst: scanBurstLimiter,
        callAdmission: async (t) => {
          const { data, error } = await (await session()).rpc("cbc_admit_scan", { p_input_type: t })
          return { data, error }
        },
      }),
    createScan,
    markProcessing: markScanProcessing,
    normalizeTarget: normalizeScanTarget,
    getProviders: () => getFastProviders("url"),
    callPaid: async (provider, admissionId, url, signal) => {
      if (provider.name !== "google_web_risk") throw new Error("No guarded entry point for this paid provider")
      return callWebRiskGuarded({
        admissionId,
        url,
        signal,
        // The deadline signal cancels the reservation RPC over HTTP. A reservation the database commits anyway is
        // never used: guardedPaidCall re-checks the signal before any request.
        reserve: async (p, id, sig) => {
          const query = (await session()).rpc("cbc_reserve_provider_call", {
            p_provider: p,
            p_admission_id: Number(id),
          })
          const { data, error } = await (sig ? query.abortSignal(sig) : query)
          return { data, error }
        },
      })
    },
    scoring: {
      confidence: calculateConfidenceFromProviders,
      risk: calculateRiskScoreFromProviders,
      evidence: buildEvidenceItem,
      vendor: buildVendorResultRow,
    },
    persist: persistFastScanResult,
    failScan,
    retryHeaders: rateLimitHeaders,
    now: () => Date.now(),
    timer: (ms) => {
      let handle: ReturnType<typeof setTimeout> | undefined
      const done = new Promise<void>((resolve) => { handle = setTimeout(resolve, ms) })
      return { done, clear: () => clearTimeout(handle) }
    },
    logError: (message, error) => console.error(message, error),
  })

  return NextResponse.json(result.body, { status: result.status, headers: result.headers })
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

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 })
}
