import "server-only"
import type { ScanProvider, ScanProviderResult, ProviderInputType } from "./types"

const TIMEOUT_MS = 8000

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallback: T
): Promise<T> {
  const timeout = new Promise<T>((resolve) =>
    setTimeout(() => resolve(fallback), ms)
  )
  try {
    return await Promise.race([promise, timeout])
  } catch {
    return fallback
  }
}

async function fetchWebRisk(url: string): Promise<ScanProviderResult> {
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

  try {
    const params = new URLSearchParams({ key: apiKey, uri: url })
    params.append("threatTypes", "MALWARE")
    params.append("threatTypes", "SOCIAL_ENGINEERING")
    params.append("threatTypes", "UNWANTED_SOFTWARE")

    const response = await fetch(
      `https://webrisk.googleapis.com/v1/uris:search?${params.toString()}`,
      { method: "GET", headers: { "Content-Type": "application/json" } }
    )

    const responseTimeMs = Date.now() - startTime

    if (!response.ok) {
      const errorText = await response.text()
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
    return {
      verdict: "error",
      error: String(error),
      scoreImpact: 0,
      confidenceImpact: -15,
      evidenceTitle: "Google Web Risk check could not complete",
      evidenceDetail: `Check failed: ${String(error)}`,
      evidenceSeverity: "info",
      rawResponse: null,
      responseTimeMs: Date.now() - startTime,
    }
  }
}

export const googleWebRiskProvider: ScanProvider = {
  name: "google_web_risk",
  displayName: "Google Web Risk",
  path: "fast",
  enabled: true,

  supportedInputTypes: ["url", "domain"],

  privacyLevel: "full_url",
  sendsFullUrl: true,
  sendsUrlPath: true,
  sendsQueryString: true,
  requiresCustomerDisclosure: true,
  requiresCommercialApproval: false,

  timeoutMs: TIMEOUT_MS,

  async run(input: string, _inputType: ProviderInputType): Promise<ScanProviderResult> {
    return withTimeout(
      fetchWebRisk(input),
      TIMEOUT_MS,
      {
        verdict: "error",
        error: "Timeout",
        scoreImpact: 0,
        confidenceImpact: -15,
        evidenceTitle: "Google Web Risk check timed out",
        evidenceDetail: "The check did not complete in time. Result may be incomplete.",
        evidenceSeverity: "info",
        rawResponse: null,
        responseTimeMs: TIMEOUT_MS,
      }
    )
  },
}
