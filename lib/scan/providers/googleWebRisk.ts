import "server-only"
import type { ScanProvider, ScanProviderResult } from "./types"
import { guardedPaidCall, WEB_RISK_PROVIDER, type GuardedOutcome } from "@/lib/security/providerBudget"

// Gate 007A: Google Web Risk is a PAID provider. The ONLY way to make a request is callWebRiskGuarded(), which
// reserves exactly one unit of the execution-time budget (cbc_reserve_provider_call) and then makes exactly one
// request. fetchWebRisk is deliberately not exported, and the provider's run() never makes a request.
const TIMEOUT_MS = 7000
const MAX_ERROR_BODY_CHARS = 500

function notConfiguredResult(): ScanProviderResult {
  return {
    verdict: "skipped",
    skipped: true,
    scoreImpact: 0,
    confidenceImpact: -25,
    evidenceTitle: "Google Web Risk not checked",
    evidenceDetail: "GOOGLE_WEB_RISK_API_KEY not configured.",
    evidenceSeverity: "info",
    rawResponse: null,
    responseTimeMs: 0,
  }
}

// Exactly one request; an AbortController cancels it at TIMEOUT_MS, so nothing keeps running in the background.
// The caller's deadline signal (scan flow) also aborts it, so no request outlives the scan request.
async function fetchWebRisk(url: string, deadline?: AbortSignal): Promise<ScanProviderResult> {
  const apiKey = process.env.GOOGLE_WEB_RISK_API_KEY
  const startTime = Date.now()

  if (!apiKey) {
    return {
      verdict: "skipped",
      skipped: true,
      scoreImpact: 0,
      confidenceImpact: -25,
      evidenceTitle: "Google Web Risk not checked",
      evidenceDetail: "GOOGLE_WEB_RISK_API_KEY not configured.",
      evidenceSeverity: "info",
      rawResponse: null,
      responseTimeMs: 0,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const onDeadline = () => controller.abort()
  deadline?.addEventListener("abort", onDeadline, { once: true })
  if (deadline?.aborted) controller.abort()
  try {
    // The API key travels in the X-Goog-Api-Key header, never in the URL, so it cannot leak through URL logging
    // or error messages (AGENTS.md section 11).
    const params = new URLSearchParams({ uri: url })
    params.append("threatTypes", "MALWARE")
    params.append("threatTypes", "SOCIAL_ENGINEERING")
    params.append("threatTypes", "UNWANTED_SOFTWARE")

    const response = await fetch(
      `https://webrisk.googleapis.com/v1/uris:search?${params.toString()}`,
      { method: "GET", headers: { "X-Goog-Api-Key": apiKey }, redirect: "error", signal: controller.signal }
    )

    const responseTimeMs = Date.now() - startTime

    if (!response.ok) {
      // Stored in vendor_results: keep only a bounded excerpt of Google's error body.
      const errorText = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS)
      return {
        verdict: "error",
        error: `API error ${response.status}: ${errorText}`,
        scoreImpact: 0,
        confidenceImpact: -15,
        evidenceTitle: "Google Web Risk check could not complete",
        evidenceDetail: `Check failed: API error ${response.status}`,
        evidenceSeverity: "info",
        rawResponse: { status: response.status, body: errorText },
        responseTimeMs,
      }
    }

    const data = await response.json()
    const flagged = !!(data.threat?.threatTypes?.length > 0)
    const threatType = flagged ? data.threat.threatTypes[0] : undefined

    if (flagged) {
      return {
        verdict: "dangerous",
        threatType,
        scoreImpact: 65,
        confidenceImpact: 30,
        evidenceTitle: "Flagged by Google Web Risk",
        evidenceDetail: `Google has identified this as: ${threatType ?? "dangerous content"}`,
        evidenceSeverity: "critical",
        rawResponse: data,
        responseTimeMs,
      }
    }

    return {
      verdict: "clean",
      scoreImpact: 0,
      confidenceImpact: 30,
      evidenceTitle: "Google Web Risk: Not flagged",
      evidenceDetail: "This URL is not currently flagged by Google Web Risk.",
      evidenceSeverity: "good",
      rawResponse: data,
      responseTimeMs,
    }
  } catch (error) {
    const timedOut = controller.signal.aborted
    return {
      verdict: "error",
      error: timedOut ? "Timeout" : String(error),
      scoreImpact: 0,
      confidenceImpact: -15,
      evidenceTitle: timedOut ? "Google Web Risk check timed out" : "Google Web Risk check could not complete",
      evidenceDetail: timedOut ? "The check did not complete in time. Result may be incomplete." : `Check failed: ${String(error)}`,
      evidenceSeverity: "info",
      rawResponse: null,
      responseTimeMs: Date.now() - startTime,
    }
  } finally {
    clearTimeout(timer)
    deadline?.removeEventListener("abort", onDeadline)
  }
}

export type WebRiskReserve = (provider: string, admissionId: string, signal?: AbortSignal) => Promise<{ data: unknown; error: unknown }>

// The single guarded entry point for every Google Web Risk request.
// - Not configured (no API key): no reservation, no request, a "skipped" result (scan cannot become "safe").
// - Otherwise: one reservation (fail closed on anything but a grant), then exactly one request.
// - signal (the scan's deadline): no reservation, no request and no late request once it is aborted
//   (guardedPaidCall contract item 4); an in-flight request is aborted.
export async function callWebRiskGuarded(args: {
  admissionId: string | undefined
  url: string
  reserve: WebRiskReserve
  signal?: AbortSignal
}): Promise<GuardedOutcome<ScanProviderResult> | { called: false; notConfigured: true; result: ScanProviderResult }> {
  if (!process.env.GOOGLE_WEB_RISK_API_KEY) return { called: false, notConfigured: true, result: notConfiguredResult() }
  return guardedPaidCall({
    provider: WEB_RISK_PROVIDER,
    admissionId: args.admissionId,
    reserve: args.reserve,
    signal: args.signal,
    call: (signal) => fetchWebRisk(args.url, signal),
  })
}

export const googleWebRiskProvider: ScanProvider = {
  name: "google_web_risk",
  displayName: "Google Web Risk",
  path: "fast",
  paid: true,
  enabled: process.env.WEB_RISK_PROVIDER_ENABLED !== "false",

  supportedInputTypes: ["url", "domain"],

  privacyLevel: "full_url",
  sendsFullUrl: true,
  sendsUrlPath: true,
  sendsQueryString: true,
  requiresCustomerDisclosure: true,
  requiresCommercialApproval: false,

  timeoutMs: TIMEOUT_MS,

  // Never makes a request: paid calls must go through callWebRiskGuarded() with an execution-time reservation.
  async run(): Promise<ScanProviderResult> {
    return {
      verdict: "error",
      error: "Reservation required",
      scoreImpact: 0,
      confidenceImpact: -15,
      evidenceTitle: "Google Web Risk not checked",
      evidenceDetail: "Paid provider calls require a budget reservation and are only made in the scan request.",
      evidenceSeverity: "info",
      rawResponse: null,
      responseTimeMs: 0,
    }
  },
}
