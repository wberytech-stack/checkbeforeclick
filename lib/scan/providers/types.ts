// Scanner provider interface contract
// Every scan provider must implement this shape.
// Privacy and commercial risk must be declared explicitly — not assumed.

export type ProviderInputType = "url" | "domain" | "email" | "header"

export type ProviderPrivacyLevel =
  | "no_external"    // nothing leaves our infrastructure
  | "domain_only"    // only hostname sent externally, no path or query string
  | "full_url"       // full URL sent to third party
  | "full_content"   // full email/header content sent to third party

export type ProviderPath = "fast" | "async"

export type ProviderVerdict =
  | "clean"
  | "dangerous"
  | "suspicious"
  | "unknown"
  | "skipped"
  | "error"

export type EvidenceSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low"
  | "info"
  | "good"

export interface ScanProviderResult {
  verdict: ProviderVerdict
  threatType?: string
  scoreImpact: number          // added to risk score (positive = more risky)
  confidenceImpact: number     // added to confidence score (positive = more confident)
  evidenceTitle: string
  evidenceDetail: string
  evidenceSeverity: EvidenceSeverity
  rawResponse: unknown
  responseTimeMs: number
  error?: string
  skipped?: boolean
}

export interface ScanProvider {
  // Identity
  name: string                              // snake_case, used in vendor_results
  displayName: string                       // shown in "What we checked"
  path: ProviderPath                        // fast = synchronous, async = Inngest
  enabled: boolean                          // runtime feature flag

  // Input
  supportedInputTypes: ProviderInputType[]

  // Privacy — must be declared explicitly, never assumed
  privacyLevel: ProviderPrivacyLevel
  sendsFullUrl: boolean                     // true if full URL including path/query sent
  sendsUrlPath: boolean                     // true if URL path sent
  sendsQueryString: boolean                 // true if query string sent
  requiresCustomerDisclosure: boolean       // true if Privacy Policy must mention this
  requiresCommercialApproval: boolean       // true if commercial SaaS use needs approval

  // Execution
  timeoutMs: number
  run(
    input: string,
    inputType: ProviderInputType
  ): Promise<ScanProviderResult>
}
