// Shared scan scoring, confidence, and evidence types
// Pure functions — no secrets, no env vars, no server-only required

import type { ScanProviderResult, EvidenceSeverity } from "./providers/types"

export type { EvidenceSeverity }
export type Severity = EvidenceSeverity

export type EvidenceItem = {
  scan_id: string
  organization_id: string
  signal_type: string
  severity: EvidenceSeverity
  title: string
  detail: string
  score_impact: number
}

export type VendorResultRow = {
  scan_id: string
  organization_id: string
  vendor_name: string
  verdict: string
  raw_response: unknown
  error_message: string | null
  response_time_ms: number
}

// Build evidence item from a provider result
export function buildEvidenceItem(
  scan_id: string,
  organization_id: string,
  providerName: string,
  result: ScanProviderResult
): EvidenceItem {
  return {
    scan_id,
    organization_id,
    signal_type: providerName,
    severity: result.evidenceSeverity,
    title: result.evidenceTitle,
    detail: result.evidenceDetail,
    score_impact: result.scoreImpact,
  }
}

// Build vendor result row from a provider result
export function buildVendorResultRow(
  scan_id: string,
  organization_id: string,
  providerName: string,
  result: ScanProviderResult
): VendorResultRow {
  return {
    scan_id,
    organization_id,
    vendor_name: providerName,
    verdict: result.verdict,
    raw_response: result.rawResponse,
    error_message: result.error ?? null,
    response_time_ms: result.responseTimeMs,
  }
}

// Calculate risk score from multiple provider results
// Domain age alone can make a scan suspicious, never dangerous by itself
export function calculateRiskScoreFromProviders(
  results: Array<{ providerName: string; result: ScanProviderResult }>
): { riskScore: number; verdict: string } {
  let score = 0

  for (const { result } of results) {
    if (result.verdict !== "error" && result.verdict !== "skipped") {
      score += result.scoreImpact
    }
  }

  score = Math.min(100, Math.max(0, score))

  const hasReputableDangerousSignal = results.some(
    (r) =>
      r.result.verdict === "dangerous" &&
      r.providerName === "google_web_risk"
  )

  let verdict: string

  if (score >= 60 && hasReputableDangerousSignal) {
    verdict = "dangerous"
  } else if (score >= 20) {
    verdict = "suspicious"
  } else {
    verdict = "safe"
  }

  return { riskScore: score, verdict }
}

// Calculate confidence score from multiple provider results
export function calculateConfidenceFromProviders(
  results: Array<{ result: ScanProviderResult }>,
  totalProviders: number
): number {
  let score = 50

  for (const { result } of results) {
    score += result.confidenceImpact
  }

  // Penalty if no providers ran at all
  if (totalProviders === 0) score = 10

  return Math.min(100, Math.max(0, score))
}

// Legacy single-provider helpers — kept for Inngest worker compatibility
// Will be removed once processScan.ts is fully migrated
export function calculateRiskScore(signals: {
  webRiskFlagged: boolean
  webRiskSkipped: boolean
  targetValid: boolean
}): { riskScore: number; verdict: string } {
  let score = 0
  if (signals.webRiskFlagged) score += 65
  if (!signals.targetValid) score = 0
  score = Math.min(100, Math.max(0, score))

  let verdict: string
  if (!signals.targetValid) {
    verdict = "unknown"
  } else if (score >= 60) {
    verdict = "dangerous"
  } else if (score >= 20) {
    verdict = "suspicious"
  } else if (signals.webRiskSkipped) {
    verdict = "unknown"
  } else {
    verdict = "safe"
  }

  return { riskScore: score, verdict }
}

export function calculateConfidence(signals: {
  webRiskSkipped: boolean
  webRiskError: boolean
  targetValid: boolean
}): number {
  if (!signals.targetValid) return 10
  let score = 50
  if (!signals.webRiskSkipped && !signals.webRiskError) score += 30
  if (signals.webRiskSkipped) score -= 25
  if (signals.webRiskError) score -= 15
  return Math.min(100, Math.max(0, score))
}

export function buildWebRiskEvidence(
  scan_id: string,
  organization_id: string,
  webRisk: {
    flagged: boolean
    threatType?: string
    error?: string
    skipped?: boolean
  }
): EvidenceItem {
  if (webRisk.skipped) {
    return {
      scan_id,
      organization_id,
      signal_type: "google_web_risk_skipped",
      severity: "info",
      title: "Google Web Risk not checked",
      detail: "GOOGLE_WEB_RISK_API_KEY not configured. Add it to enable this check.",
      score_impact: 0,
    }
  }
  if (webRisk.error && !webRisk.flagged) {
    return {
      scan_id,
      organization_id,
      signal_type: "google_web_risk_error",
      severity: "info",
      title: "Google Web Risk check could not complete",
      detail: `Check failed: ${webRisk.error}`,
      score_impact: 0,
    }
  }
  if (webRisk.flagged) {
    return {
      scan_id,
      organization_id,
      signal_type: "google_web_risk_flagged",
      severity: "critical",
      title: "Flagged by Google Web Risk",
      detail: `Google has identified this as: ${webRisk.threatType ?? "dangerous content"}`,
      score_impact: 65,
    }
  }
  return {
    scan_id,
    organization_id,
    signal_type: "google_web_risk_clean",
    severity: "good",
    title: "Google Web Risk: Not flagged",
    detail: "This URL is not currently flagged by Google Web Risk.",
    score_impact: -5,
  }
}