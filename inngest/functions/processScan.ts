import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"
import { normalizeScanTarget } from "@/lib/security/urlSafety"
import { getFastProviders, getAsyncProviders } from "@/lib/scan/providers"
import {
  calculateRiskScoreFromProviders,
  calculateConfidenceFromProviders,
  buildEvidenceItem,
  buildVendorResultRow,
} from "@/lib/scan/scanHelpers"

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
    const { scan_id } = event.data
    const supabase = getServiceClient()
    const startTime = Date.now()

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

    await supabase
      .from("scans")
      .update({ status: "processing" })
      .eq("id", scan_id)

    try {
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

      // Use normalized URL if available, otherwise raw input
      // For email/header, normalizeScanTarget extracts the first URL found
      const providerInput = target.normalizedUrl ?? raw_input
      const providerInputType = target.normalizedUrl ? "url" : input_type

      // If a URL was extracted, run URL-capable providers inside Inngest
      // If no URL extracted, get async providers for the input type
      const providers = target.normalizedUrl
        ? getFastProviders("url")
        : getAsyncProviders(input_type as "email" | "header")

      // If no providers available, complete as unknown
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

        return { scan_id, verdict: "unknown", reason: "No providers available for this input" }
      }

      // Run all providers in parallel
      const providerResults = await Promise.allSettled(
        providers.map((provider) =>
          provider.run(providerInput, providerInputType as "url" | "domain")
        )
      )

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

      const confidenceScore = calculateConfidenceFromProviders(results, providers.length)
      const { riskScore, verdict } = calculateRiskScoreFromProviders(results, confidenceScore)
      const scanDurationMs = Date.now() - startTime

      const evidenceRows = results.map(({ providerName, result }) =>
        buildEvidenceItem(scan_id, organization_id, providerName, result)
      )
      if (evidenceRows.length > 0) {
        await supabase.from("evidence_items").insert(evidenceRows)
      }

      const vendorRows = results.map(({ providerName, result }) =>
        buildVendorResultRow(scan_id, organization_id, providerName, result)
      )
      if (vendorRows.length > 0) {
        await supabase.from("vendor_results").insert(vendorRows)
      }

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
