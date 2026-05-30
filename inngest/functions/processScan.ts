import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"
import { normalizeScanTarget } from "@/lib/security/urlSafety"
import { getAsyncProviders } from "@/lib/scan/providers"
import {
  calculateRiskScoreFromProviders,
  calculateConfidenceFromProviders,
  buildEvidenceItem,
  buildVendorResultRow,
} from "@/lib/scan/scanHelpers"

// Service role client for background jobs only
// Bypasses RLS safely - never used in client code
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )
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

    try {
      // SSRF validation
      const target = normalizeScanTarget(raw_input, input_type)

      if (!target.ok) {
        await supabase.from("evidence_items").insert({
          scan_id,
          organization_id,
          signal_type: "invalid_target",
          severity: "info",
          title: "Target could not be safely scanned",
          detail: target.reason ?? "Input could not be parsed into a safe scan target.",
          score_impact: 0,
        })

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

      // Get all enabled async providers for this input type
      const providers = getAsyncProviders(input_type as "url" | "domain" | "email" | "header")

      // If no async providers registered, complete as unknown
      if (providers.length === 0) {
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

        return { scan_id, verdict: "unknown", reason: "No async providers configured" }
      }

      // Run all async providers in parallel
      const scanInput = target.normalizedUrl ?? raw_input
      const providerResults = await Promise.allSettled(
        providers.map((provider) =>
          provider.run(scanInput, input_type as "url" | "domain" | "email" | "header")
        )
      )

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

      // Calculate scores
      const { riskScore, verdict } = calculateRiskScoreFromProviders(results)
      const confidenceScore = calculateConfidenceFromProviders(results, providers.length)
      const scanDurationMs = Date.now() - startTime

      // Write evidence_items
      const evidenceRows = results.map(({ providerName, result }) =>
        buildEvidenceItem(scan_id, organization_id, providerName, result)
      )
      if (evidenceRows.length > 0) {
        await supabase.from("evidence_items").insert(evidenceRows)
      }

      // Write vendor_results
      const vendorRows = results.map(({ providerName, result }) =>
        buildVendorResultRow(scan_id, organization_id, providerName, result)
      )
      if (vendorRows.length > 0) {
        await supabase.from("vendor_results").insert(vendorRows)
      }

      // Update scan to complete
      await supabase
        .from("scans")
        .update({
          status: "complete",
          risk_score: riskScore,
          confidence_score: confidenceScore,
          verdict,
          completed_at: new Date().toISOString(),
          scan_duration_ms: scanDurationMs,
        })
        .eq("id", scan_id)

      return { scan_id, verdict, riskScore, confidenceScore }

    } catch (error) {
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