// Shared scan scoring, confidence, and evidence types
// Pure functions — no secrets, no env vars, no server-only required

export type Severity = "critical" | "high" | "medium" | "low" | "info" | "good"

export type EvidenceItem = {
  scan_id: string
  organization_id: string
  signal_type: string
  severity: Severity
  title: string
  detail: string
  score_impact: number
}

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
      detail: `Google has identified this as: ${webRisk.threatType || "dangerous content"}`,
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
