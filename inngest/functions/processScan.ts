import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"

// Service role client for background jobs only
// Bypasses RLS safely - never used in client code
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
}

// Strict severity type matching database schema
type Severity = "critical" | "high" | "medium" | "low" | "info" | "good"

type EvidenceItem = {
  scan_id: string
  organization_id: string
  signal_type: string
  severity: Severity
  title: string
  detail: string
  score_impact: number
}

// Timeout wrapper
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

// Check if a string looks like a decimal integer (possible encoded IP)
function isDecimalInteger(str: string): boolean {
  return /^\d+$/.test(str)
}

// Check if a string looks like a hex-encoded IP (0x...)
function isHexEncoded(str: string): boolean {
  return /^0x[0-9a-fA-F]+$/.test(str)
}

// Check if a string looks like an octal-encoded IP (0...)
function isOctalEncoded(str: string): boolean {
  return /^0[0-7]+$/.test(str)
}

// Validate if an IPv4 address string is in a private/reserved range
function checkIPv4Safety(ip: string): string | null {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return null
  }
  const [a, b] = parts
  if (a === 0) return "0.0.0.0/8 reserved range"
  if (a === 10) return "10.0.0.0/8 private range"
  if (a === 127) return "127.0.0.0/8 loopback range"
  if (a === 169 && b === 254) return "169.254.0.0/16 link-local range"
  if (a === 172 && b >= 16 && b <= 31) return "172.16.0.0/12 private range"
  if (a === 192 && b === 168) return "192.168.0.0/16 private range"
  if (a >= 224 && a <= 239) return "224.0.0.0/4 multicast range"
  if (a >= 240) return "240.0.0.0/4 reserved range"
  return null
}

// Validate IPv6 safety
function checkIPv6Safety(ip: string): string | null {
  const lower = ip.toLowerCase()
  if (lower === "::1") return "IPv6 loopback address"
  if (lower.startsWith("fc") || lower.startsWith("fd")) return "IPv6 fc00::/7 private range"
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) {
    return "IPv6 fe80::/10 link-local range"
  }
  return null
}

const BLOCKED_SINGLE_LABELS = new Set([
  "localhost", "intranet", "internal", "local", "server",
  "gateway", "router", "printer", "nas", "admin", "vpn",
  "mail", "exchange", "dc", "fileserver",
])

// Core hostname safety check
// IMPORTANT: Before any server-side fetch, redirect following, screenshotting,
// URLScan enrichment, or browser automation, resolved DNS IPs must also
// be checked against private/internal ranges using a DNS lookup.
function checkHostnameSafety(hostname: string): string | null {
  if (!hostname || hostname.length === 0) return "Empty hostname"
  const lower = hostname.toLowerCase()

  if (lower === "localhost" || lower.endsWith(".localhost") ||
      lower === "localhost.localdomain") {
    return "Localhost is not allowed"
  }

  if (!lower.includes(".")) {
    if (BLOCKED_SINGLE_LABELS.has(lower)) {
      return `Internal hostname "${lower}" is not allowed`
    }
    return `Single-label hostname "${lower}" is not a valid public domain`
  }

  if (isDecimalInteger(lower)) return "Decimal-encoded IP addresses are not allowed"
  if (isHexEncoded(lower)) return "Hexadecimal-encoded IP addresses are not allowed"
  if (isOctalEncoded(lower)) return "Octal-encoded IP addresses are not allowed"

  const ipv4Blocked = checkIPv4Safety(lower)
  if (ipv4Blocked) return `Private/reserved IP blocked: ${ipv4Blocked}`

  const ipv6Candidate = lower.replace(/^\[/, "").replace(/\]$/, "")
  const ipv6Blocked = checkIPv6Safety(ipv6Candidate)
  if (ipv6Blocked) return `Private/reserved IPv6 blocked: ${ipv6Blocked}`

  return null
}

// SSRF-safe target normalization
function normalizeScanTarget(
  rawInput: string,
  inputType: string
): {
  ok: boolean
  normalizedUrl?: string
  domain?: string
  reason?: string
} {
  const BLOCKED_PROTOCOLS = [
    "file:", "ftp:", "gopher:", "data:",
    "javascript:", "ldap:", "dict:",
  ]

  try {
    let rawUrl: string

    if (inputType === "url") {
      rawUrl = rawInput.trim()
    } else if (inputType === "domain") {
      const domain = rawInput.trim().toLowerCase()
      if (/\s/.test(domain)) return { ok: false, reason: "Domain contains spaces and cannot be checked." }
      if (domain.includes("/") || domain.includes("\\")) return { ok: false, reason: "Input looks like a path, not a domain." }
      if (domain.length === 0 || domain.length > 253) return { ok: false, reason: "Domain length is invalid." }
      if (isDecimalInteger(domain) || isHexEncoded(domain) || isOctalEncoded(domain)) {
        return { ok: false, reason: "Encoded IP addresses are not allowed as domain input." }
      }
      const labelPattern = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
      if (!labelPattern.test(domain)) return { ok: false, reason: "Domain format is not valid." }
      rawUrl = `https://${domain}`
    } else {
      const match = rawInput.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/)
      if (!match) return { ok: false, reason: "No URL found in the submitted content." }
      rawUrl = match[0]
    }

    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return { ok: false, reason: "URL format is not valid." }
    }

    if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
      return { ok: false, reason: `Protocol "${parsed.protocol}" is not allowed.` }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "Only http and https URLs are supported." }
    }

    const hostnameDanger = checkHostnameSafety(parsed.hostname)
    if (hostnameDanger) return { ok: false, reason: hostnameDanger }

    return {
      ok: true,
      normalizedUrl: parsed.toString(),
      domain: parsed.hostname.toLowerCase(),
    }
  } catch {
    return { ok: false, reason: "Input could not be safely parsed." }
  }
}

// Google Web Risk Lookup API check
// Requires GOOGLE_WEB_RISK_API_KEY
async function checkGoogleWebRisk(url: string): Promise<{
  flagged: boolean
  threatType?: string
  error?: string
  skipped?: boolean
}> {
  const apiKey = process.env.GOOGLE_WEB_RISK_API_KEY

  if (!apiKey) {
    return { flagged: false, skipped: true, error: "API key not configured" }
  }

  try {
    const params = new URLSearchParams({
      key: apiKey,
      uri: url,
    })
    params.append("threatTypes", "MALWARE")
    params.append("threatTypes", "SOCIAL_ENGINEERING")
    params.append("threatTypes", "UNWANTED_SOFTWARE")

    const response = await fetch(
      `https://webrisk.googleapis.com/v1/uris:search?${params.toString()}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      return { flagged: false, error: `API error ${response.status}: ${errorText}` }
    }

    const data = await response.json()

    // Web Risk returns { threat: { threatTypes: [...], expireTime: ... } } if flagged
    // Returns empty {} if clean
    const flagged = !!(data.threat && data.threat.threatTypes && data.threat.threatTypes.length > 0)
    const threatType = flagged ? data.threat.threatTypes[0] : undefined

    return { flagged, threatType }
  } catch (error) {
    return { flagged: false, error: String(error) }
  }
}

// Calculate risk score
function calculateRiskScore(signals: {
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

// Calculate confidence score
function calculateConfidence(signals: {
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

export const processScan = inngest.createFunction(
  {
    id: "process-scan",
    retries: 1,
    triggers: [{ event: "scan/requested" }],
  },
  async ({ event }) => {
    // Only trust scan_id from event
    // All scan data loaded from database - never trust client values
    const { scan_id } = event.data
    const supabase = getServiceClient()
    const startTime = Date.now()

    // Load scan record from database
    const { data: scanRecord, error: scanLoadError } = await supabase
      .from("scans")
      .select("id, organization_id, raw_input, input_type")
      .eq("id", scan_id)
      .single()

    // Catastrophic error if scan or org missing
    if (scanLoadError || !scanRecord) {
      throw new Error(`Could not load scan record for scan_id: ${scan_id}`)
    }
    if (!scanRecord.organization_id) {
      throw new Error(`Scan ${scan_id} has no organization_id - cannot proceed`)
    }

    const { organization_id, raw_input, input_type } = scanRecord

    // Update status to processing
    await supabase
      .from("scans")
      .update({ status: "processing" })
      .eq("id", scan_id)

    const evidenceItems: EvidenceItem[] = []

    try {
      // Normalize and validate target with full SSRF protection
      const target = normalizeScanTarget(raw_input, input_type)

      if (!target.ok) {
        // Bad or unsafe input - complete as unknown, not failed
        evidenceItems.push({
          scan_id,
          organization_id,
          signal_type: "invalid_target",
          severity: "info",
          title: "Target could not be safely scanned",
          detail: target.reason || "Input could not be parsed into a safe scan target.",
          score_impact: 0,
        })

        await supabase.from("evidence_items").insert(evidenceItems)
        await supabase
          .from("scans")
          .update({
            status: "complete",
            risk_score: 0,
            confidence_score: 10,
            verdict: "unknown",
            completed_at: new Date().toISOString(),
            scan_duration_ms: Date.now() - startTime,
          })
          .eq("id", scan_id)

        return { scan_id, verdict: "unknown", reason: target.reason }
      }

      // Run scanners in parallel with timeout
      // Promise.allSettled ensures one failure never kills the whole scan
      const [webRiskResult] = await Promise.allSettled([
        withTimeout(
          checkGoogleWebRisk(target.normalizedUrl!),
          8000,
          { flagged: false, error: "Timeout", skipped: false }
        ),
      ])

      const webRisk =
        webRiskResult.status === "fulfilled"
          ? webRiskResult.value
          : { flagged: false, error: "Scanner failed", skipped: false }

      // Build evidence items
      if (webRisk.skipped) {
        evidenceItems.push({
          scan_id,
          organization_id,
          signal_type: "google_web_risk_skipped",
          severity: "info",
          title: "Google Web Risk not checked",
          detail: "GOOGLE_WEB_RISK_API_KEY not configured. Add it to enable this check.",
          score_impact: 0,
        })
      } else if (webRisk.error && !webRisk.flagged) {
        evidenceItems.push({
          scan_id,
          organization_id,
          signal_type: "google_web_risk_error",
          severity: "info",
          title: "Google Web Risk check could not complete",
          detail: `Check failed: ${webRisk.error}`,
          score_impact: 0,
        })
      } else if (webRisk.flagged) {
        evidenceItems.push({
          scan_id,
          organization_id,
          signal_type: "google_web_risk_flagged",
          severity: "critical",
          title: "Flagged by Google Web Risk",
          detail: `Google has identified this as: ${webRisk.threatType || "dangerous content"}`,
          score_impact: 65,
        })
      } else {
        evidenceItems.push({
          scan_id,
          organization_id,
          signal_type: "google_web_risk_clean",
          severity: "good",
          title: "Google Web Risk: Not flagged",
          detail: "This URL is not currently flagged by Google Web Risk.",
          score_impact: -5,
        })
      }

      // Calculate scores
      const { riskScore, verdict } = calculateRiskScore({
        webRiskFlagged: webRisk.flagged,
        webRiskSkipped: !!webRisk.skipped,
        targetValid: true,
      })

      const confidenceScore = calculateConfidence({
        webRiskSkipped: !!webRisk.skipped,
        webRiskError: !!webRisk.error,
        targetValid: true,
      })

      // Save evidence items
      await supabase.from("evidence_items").insert(evidenceItems)

      // Save vendor result
      await supabase.from("vendor_results").insert({
        scan_id,
        organization_id,
        vendor_name: "google_web_risk",
        verdict: webRisk.flagged ? "dangerous" : webRisk.skipped ? "skipped" : "clean",
        raw_response: webRisk,
        error_message: webRisk.error || null,
        response_time_ms: Date.now() - startTime,
      })

      // Update scan to complete
      await supabase
        .from("scans")
        .update({
          status: "complete",
          risk_score: riskScore,
          confidence_score: confidenceScore,
          verdict,
          completed_at: new Date().toISOString(),
          scan_duration_ms: Date.now() - startTime,
        })
        .eq("id", scan_id)

      return { scan_id, verdict, riskScore, confidenceScore }

    } catch (error) {
      // Mark failed only for system/database/job failures
      await supabase
        .from("scans")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          scan_duration_ms: Date.now() - startTime,
        })
        .eq("id", scan_id)

      throw error
    }
  }
)

