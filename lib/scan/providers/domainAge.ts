import "server-only"
import type { ScanProvider, ScanProviderResult, ProviderInputType } from "./types"

const TIMEOUT_MS = 8000

// Extract registerable domain from hostname
// e.g. "login.paypal-secure.xyz" → "paypal-secure.xyz"
function getRegisterableDomain(hostname: string): string {
  const parts = hostname.toLowerCase().split(".")
  if (parts.length <= 2) return hostname
  // Return last two parts as registerable domain
  // Simple heuristic — sufficient for MVP
  return parts.slice(-2).join(".")
}

// Parse RDAP registration date from response
function parseRdapDate(rdapResponse: Record<string, unknown>): Date | null {
  try {
    const events = rdapResponse.events as Array<{ eventAction: string; eventDate: string }> | undefined
    if (!events) return null

    const registrationEvent = events.find(
      (e) => e.eventAction === "registration"
    )
    if (!registrationEvent?.eventDate) return null

    const date = new Date(registrationEvent.eventDate)
    return isNaN(date.getTime()) ? null : date
  } catch {
    return null
  }
}

// Calculate domain age in days from registration date
function getDomainAgeDays(registrationDate: Date): number {
  const now = new Date()
  const diffMs = now.getTime() - registrationDate.getTime()
  return Math.floor(diffMs / (1000 * 60 * 60 * 24))
}

async function fetchDomainAge(domain: string): Promise<ScanProviderResult> {
  const startTime = Date.now()
  const registerable = getRegisterableDomain(domain)

  try {
    // RDAP bootstrap — try common TLD RDAP endpoints
    // ICANN RDAP lookup service
    const rdapUrl = `https://rdap.org/domain/${registerable}`

    const response = await fetch(rdapUrl, {
      method: "GET",
      headers: {
        "Accept": "application/rdap+json",
        "User-Agent": "CheckBeforeClick-SecurityScanner/1.0",
      },
    })

    const responseTimeMs = Date.now() - startTime

    if (!response.ok) {
      // RDAP not available for this TLD or domain not found
      return {
        verdict: "unknown",
        skipped: false,
        scoreImpact: 0,
        confidenceImpact: -5,
        evidenceTitle: "Domain age could not be determined",
        evidenceDetail: "Registration data is not available for this domain.",
        evidenceSeverity: "info",
        rawResponse: { status: response.status },
        responseTimeMs,
      }
    }

    const data = await response.json() as Record<string, unknown>
    const registrationDate = parseRdapDate(data)
    const responseTimeMs2 = Date.now() - startTime

    if (!registrationDate) {
      return {
        verdict: "unknown",
        scoreImpact: 0,
        confidenceImpact: -5,
        evidenceTitle: "Domain age could not be determined",
        evidenceDetail: "Registration date was not available in domain records.",
        evidenceSeverity: "info",
        rawResponse: data,
        responseTimeMs: responseTimeMs2,
      }
    }

    const ageDays = getDomainAgeDays(registrationDate)
    const ageYears = Math.floor(ageDays / 365)
    const ageMonths = Math.floor(ageDays / 30)

    // Scoring — domain age alone makes scan suspicious, never dangerous alone
    if (ageDays < 30) {
      return {
        verdict: "suspicious",
        scoreImpact: 30,
        confidenceImpact: 15,
        evidenceTitle: "Recently registered domain",
        evidenceDetail: `This domain was registered ${ageDays} day${ageDays === 1 ? "" : "s"} ago. Newly registered domains are commonly used in phishing attacks.`,
        evidenceSeverity: "high",
        rawResponse: data,
        responseTimeMs: responseTimeMs2,
      }
    }

    if (ageDays < 90) {
      return {
        verdict: "suspicious",
        scoreImpact: 15,
        confidenceImpact: 15,
        evidenceTitle: "Recently registered domain",
        evidenceDetail: `This domain was registered ${ageMonths} month${ageMonths === 1 ? "" : "s"} ago. Domains registered within the last 3 months carry higher risk.`,
        evidenceSeverity: "medium",
        rawResponse: data,
        responseTimeMs: responseTimeMs2,
      }
    }

    if (ageDays < 365) {
      return {
        verdict: "clean",
        scoreImpact: 5,
        confidenceImpact: 15,
        evidenceTitle: "Domain registered less than a year ago",
        evidenceDetail: `This domain was registered ${ageMonths} month${ageMonths === 1 ? "" : "s"} ago.`,
        evidenceSeverity: "low",
        rawResponse: data,
        responseTimeMs: responseTimeMs2,
      }
    }

    // Established domain
    const ageLabel = ageYears >= 1
      ? `${ageYears} year${ageYears === 1 ? "" : "s"} ago`
      : `${ageMonths} months ago`

    return {
      verdict: "clean",
      scoreImpact: 0,
      confidenceImpact: 15,
      evidenceTitle: "Established domain",
      evidenceDetail: `This domain was registered ${ageLabel}. Established domains carry lower inherent risk.`,
      evidenceSeverity: "good",
      rawResponse: data,
      responseTimeMs: responseTimeMs2,
    }

  } catch (error) {
    return {
      verdict: "error",
      error: String(error),
      scoreImpact: 0,
      confidenceImpact: -10,
      evidenceTitle: "Domain age check could not complete",
      evidenceDetail: "Registration data lookup failed. This does not indicate a problem with the domain.",
      evidenceSeverity: "info",
      rawResponse: null,
      responseTimeMs: Date.now() - startTime,
    }
  }
}

export const domainAgeProvider: ScanProvider = {
  name: "domain_age",
  displayName: "Domain age check",
  path: "fast",
  enabled: process.env.DOMAIN_AGE_PROVIDER_ENABLED !== "false",

  supportedInputTypes: ["url", "domain"],

  // Only the registerable domain is sent — no path, no query string
  privacyLevel: "domain_only",
  sendsFullUrl: false,
  sendsUrlPath: false,
  sendsQueryString: false,
  requiresCustomerDisclosure: false,
  requiresCommercialApproval: false,

  timeoutMs: TIMEOUT_MS,

  async run(input: string, inputType: ProviderInputType): Promise<ScanProviderResult> {
    try {
      // Extract hostname from URL input
      let domain: string
      if (inputType === "url") {
        const raw = input.startsWith("http") ? input : `https://${input}`
        const parsed = new URL(raw)
        domain = parsed.hostname
      } else {
        domain = input.toLowerCase().trim()
      }

      const timeoutFallback: ScanProviderResult = {
        verdict: "error",
        error: "Timeout",
        scoreImpact: 0,
        confidenceImpact: -10,
        evidenceTitle: "Domain age check timed out",
        evidenceDetail: "Registration data lookup did not complete in time.",
        evidenceSeverity: "info",
        rawResponse: null,
        responseTimeMs: TIMEOUT_MS,
      }

      const timeout = new Promise<ScanProviderResult>((resolve) =>
        setTimeout(() => resolve(timeoutFallback), TIMEOUT_MS)
      )

      return await Promise.race([fetchDomainAge(domain), timeout])

    } catch (error) {
      return {
        verdict: "error",
        error: String(error),
        scoreImpact: 0,
        confidenceImpact: -10,
        evidenceTitle: "Domain age check could not complete",
        evidenceDetail: "Registration data lookup failed.",
        evidenceSeverity: "info",
        rawResponse: null,
        responseTimeMs: 0,
      }
    }
  },
}
