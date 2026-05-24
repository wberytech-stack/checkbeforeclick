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
// Returns reason string if blocked, null if public
function checkIPv4Safety(ip: string): string | null {
  const parts = ip.split(".").map(Number)
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return null // not a valid IPv4, skip
  }

  const [a, b, c] = parts

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

// Reject single-label hostnames that look internal
const BLOCKED_SINGLE_LABELS = new Set([
  "localhost",
  "intranet",
  "internal",
  "local",
  "server",
  "gateway",
  "router",
  "printer",
  "nas",
  "admin",
  "vpn",
  "mail",
  "exchange",
  "dc",
  "fileserver",
])

// Core hostname safety check
// Returns reason string if blocked, null if safe
// IMPORTANT: This checks string patterns only.
// Before any server-side fetch, redirect following, screenshotting,
// URLScan enrichment, or browser automation, resolved DNS IPs must also
// be checked against private/internal ranges using a DNS lookup.
function checkHostnameSafety(hostname: string): string | null {
  if (!hostname || hostname.length === 0) {
    return "Empty hostname"
  }

  const lower = hostname.toLowerCase()

  // Reject localhost variants
  if (lower === "localhost" || lower.endsWith(".localhost") ||
      lower === "localhost.localdomain") {
    return "Localhost is not allowed"
  }

  // Reject single-label internal hostnames
  if (!lower.includes(".")) {
    if (BLOCKED_SINGLE_LABELS.has(lower)) {
      return `Internal hostname "${lower}" is not allowed`
    }
    // Any single-label hostname without a dot is likely internal
    return `Single-label hostname "${lower}" is not a valid public domain`
  }

  // Reject encoded IP tricks
  // Decimal integer hostnames like http://2130706433/ = 127.0.0.1
  if (isDecimalInteger(lower)) {
    return "Decimal-encoded IP addresses are not allowed"
  }

  // Hex-encoded IPs like http://0x7f000001/ = 127.0.0.1
  if (isHexEncoded(lower)) {
    return "Hexadecimal-encoded IP addresses are not allowed"
  }

  // Octal-encoded IPs like http://0177.0.0.01/ = 127.0.0.1
  if (isOctalEncoded(lower)) {
    return "Octal-encoded IP addresses are not allowed"
  }

  // Check plain IPv4
  const ipv4Blocked = checkIPv4Safety(lower)
  if (ipv4Blocked) {
    return `Private/reserved IP blocked: ${ipv4Blocked}`
  }

  // Check IPv6 (strip brackets if present)
  const ipv6Candidate = lower.replace(/^\[/, "").replace(/\]$/, "")
  const ipv6Blocked = checkIPv6Safety(ipv6Candidate)
  if (ipv6Blocked) {
    return `Private/reserved IPv6 blocked: ${ipv6Blocked}`
  }

  // Check for dotted-decimal IPv4 in hostname position
  // e.g. 192.168.1.1 passed as hostname
  const ipv4DottedBlocked = checkIPv4Safety(lower)
  if (ipv4DottedBlocked) {
    return `Private IP range blocked: ${ipv4DottedBlocked}`
  }

  return null // hostname appears safe
}

// SSRF-safe target normalization
// Returns structured result - never throws
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
    "file:",
    "ftp:",
    "gopher:",
    "data:",
    "javascript:",
    "ldap:",
    "dict:",
  ]

  try {
    let rawUrl: string

    if (inputType === "url") {
      rawUrl = rawInput.trim()
    } else if (inputType === "domain") {
      const domain = rawInput.trim().toLowerCase()

      if (/\s/.test(domain)) {
        return { ok: false, reason: "Domain contains spaces and cannot be checked." }
      }
      if (domain.includes("/") || domain.includes("\\")) {
        return { ok: false, reason: "Input looks like a path, not a domain." }
      }
      if (domain.length === 0 || domain.length > 253) {
        return { ok: false, reason: "Domain length is invalid." }
      }

      // Reject encoded IP tricks before domain validation
      if (isDecimalInteger(domain) || isHexEncoded(domain) || isOctalEncoded(domain)) {
        return { ok: false, reason: "Encoded IP addresses are not allowed as domain input." }
      }

      const labelPattern = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/
      if (!labelPattern.test(domain)) {
        return { ok: false, reason: "Domain format is not valid." }
      }

      rawUrl = `https://${domain}`
    } else {
      // email, header, signature - extract first URL
      const match = rawInput.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/)
      if (!match) {
        return { ok: false, reason: "No URL found in the submitted content." }
      }
      rawUrl = match[0]
    }

    // Parse with URL constructor
    let parsed: URL
    try {
      parsed = new URL(rawUrl)
    } catch {
      return { ok: false, reason: "URL format is not valid." }
    }

    // Reject blocked protocols
    if (BLOCKED_PROTOCOLS.includes(parsed.protocol)) {
      return { ok: false, reason: `Protocol "${parsed.protocol}" is not allowed.` }
    }

    // Only allow http and https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "Only http and https URLs are supported." }
    }

    // Validate hostname safety
    const hostnameDanger = checkHostnameSafety(parsed.hostname)
    if (hostnameDanger) {
      return { ok: false, reason: hostnameDanger }
    }

    return {
      ok: true,
      normalizedUrl: parsed.toString(),
      domain: parsed.hostname.toLowerCase(),
    }
  } catch {
    return { ok: false, reason: "Input could not be safely parsed." }
  }
}

// Google Safe Browsing check
async function checkGoogleSafeBrowsing(url: string): Promise<{
  flagged: boolean
  threatType?: string
  error?: string
  skipped?: boolean
}> {
  const apiKey = process.env.GOOGLE_SAFE_BROWSING_API_KEY

  if (!apiKey) {
    return { flagged: false, skipped: true, error: "API key not configured" }
  }

  try {
    const response = await fetch(
      `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client: { clientId: "checkbeforeclick", clientVersion: "1.0" },
          threatInfo: {
            threatTypes: [
              "MALWARE",
              "SOCIAL_ENGINEERING",
              "UNWANTED_SOFTWARE",
              "POTENTIALLY_HARMFUL_APPLICATION",
            ],
            platformTypes: ["ANY_PLATFORM"],
            threatEntryTypes: ["URL"],
            threatEntries: [{ url }],
          },
        }),
      }
    )

    if (!response.ok) {
      return { flagged: false, error: `API error: ${response.status}` }
    }

    const data = await response.json()
    const flagged = !!(data.matches && data.matches.length > 0)
    const threatType = flagged ? data.matches[0].threatType : undefined

    return { flagged, threatType }
  } catch (error) {
    return { flagged: false, error: String(error) }
  }
}

// Calculate risk score
function calculateRiskScore(signals: {
  googleFlagged: boolean
  googleSkipped: boolean
  targetValid: boolean
}): { riskScore: number; verdict: string } {
  let score = 0

  if (signals.googleFlagged) score += 60
  if (!signals.targetValid) score = 0

  score = Math.min(100, Math.max(0, score))

  let verdict: string
  if (!signals.targetValid) {
    verdict = "unknown"
  } else if (score >= 60) {
    verdict = "dangerous"
  } else if (score >= 20) {
    verdict = "suspicious"
  } else if (signals.googleSkipped) {
    verdict = "unknown"
  } else {
    verdict = "safe"
  }

  return { riskScore: score, verdict }
}

// Calculate confidence score
function calculateConfidence(signals: {
  googleSkipped: boolean
  googleError: boolean
  targetValid: boolean
}): number {
  if (!signals.targetValid) return 10

  let score = 50
  if (!signals.googleSkipped && !signals.googleError) score += 30
  if (signals.googleSkipped) score -= 25
  if (signals.googleError) score -= 15

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
    // All scan data loaded from database
    const { scan_id } = event.data
    const supabase = getServiceClient()
    const startTime = Date.now()

    // Load scan record from database - never trust client values
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
      const [googleResult] = await Promise.allSettled([
        withTimeout(
          checkGoogleSafeBrowsing(target.normalizedUrl!),
          8000,
          { flagged: false, error: "Timeout", skipped: false }
        ),
      ])

      const google =
        googleResult.status === "fulfilled"
          ? googleResult.value
          : { flagged: false, error: "Scanner failed", skipped: false }

      // Build evidence items
      if (google.skipped) {
        evidenceItems.push({
          scan_id,
          organization_id,
          signal_type: "google_safe_browsing_skipped",
          severity: "info",
          title: "Google Safe Browsing not checked",
          detail: "GOOGLE_SAFE_BROWSING_API_KEY not configured. Add it to enable this check.",
          score_impact: 0,
        })
      } else if (google.error && !google.flagged) {
        evidenceItems.push({
          scan_id,
          organization_id,
          signal_type: "google_safe_browsing_error",
          severity: "info",
          title: "Google Safe Browsing check could not complete",
          detail: `Check failed: ${google.error}`,
          score_impact: 0,
        })
      } else if (google.flagged) {
        evidenceItems.push({
          scan_id,
          organization_id,
          signal_type: "google_safe_browsing_flagged",
          severity: "critical",
          title: "Flagged by Google Safe Browsing",
          detail: `Google has identified this as: ${google.threatType || "dangerous content"}`,
          score_impact: 60,
        })
      } else {
        evidenceItems.push({
          scan_id,
          organization_id,
          signal_type: "google_safe_browsing_clean",
          severity: "good",
          title: "Google Safe Browsing: Not flagged",
          detail: "This URL is not currently flagged by Google Safe Browsing.",
          score_impact: -5,
        })
      }

      // Calculate scores
      const { riskScore, verdict } = calculateRiskScore({
        googleFlagged: google.flagged,
        googleSkipped: !!google.skipped,
        targetValid: true,
      })

      const confidenceScore = calculateConfidence({
        googleSkipped: !!google.skipped,
        googleError: !!google.error,
        targetValid: true,
      })

      // Save evidence items
      await supabase.from("evidence_items").insert(evidenceItems)

      // Save vendor result
      await supabase.from("vendor_results").insert({
        scan_id,
        organization_id,
        vendor_name: "google_safe_browsing",
        verdict: google.flagged ? "dangerous" : google.skipped ? "skipped" : "clean",
        raw_response: google,
        error_message: google.error || null,
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



