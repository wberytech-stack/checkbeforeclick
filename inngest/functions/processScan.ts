import { inngest } from "../client"
import { normalizeScanTarget } from "@/lib/security/urlSafety"
import { getFastProviders, getAsyncProviders } from "@/lib/scan/providers"
import {
  calculateRiskScoreFromProviders,
  calculateConfidenceFromProviders,
  buildEvidenceItem,
  buildVendorResultRow,
} from "@/lib/scan/scanHelpers"
import {
  loadScanForProcessing,
  markScanProcessing,
  completeScan,
  failScan,
  insertEvidenceItems,
  insertVendorResults,
} from "@/lib/data"

export const processScan = inngest.createFunction(
  {
    id: "process-scan",
    retries: 1,
    triggers: [{ event: "scan/requested" }],
  },
  async ({ event }) => {
    const { scan_id } = event.data
    const startTime = Date.now()

    // Invariant 6: reload scan + org context from the database;
    // never trust the event payload alone.
    const scanRecord = await loadScanForProcessing(scan_id)

    if (!scanRecord) {
      throw new Error(`Could not load scan record for scan_id: ${scan_id}`)
    }
    if (!scanRecord.organization_id) {
      throw new Error(`Scan ${scan_id} has no organization_id - cannot proceed`)
    }

    const { organization_id, raw_input, input_type } = scanRecord

    await markScanProcessing(organization_id, scan_id)

    try {
      const target = normalizeScanTarget(raw_input, input_type)

      if (!target.ok) {
        await insertEvidenceItems(organization_id, [
          {
            scan_id,
            signal_type: "invalid_target",
            severity: "info",
            title: "Target could not be safely scanned",
            detail: target.reason ?? "Input could not be parsed into a safe scan target.",
            score_impact: 0,
          },
        ])

        await completeScan(organization_id, scan_id, {
          riskScore: 0,
          confidenceScore: 10,
          verdict: "unknown",
          durationMs: Date.now() - startTime,
        })

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
        await completeScan(organization_id, scan_id, {
          riskScore: 0,
          confidenceScore: 10,
          verdict: "unknown",
          durationMs: Date.now() - startTime,
        })

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
      await insertEvidenceItems(organization_id, evidenceRows)

      const vendorRows = results.map(({ providerName, result }) =>
        buildVendorResultRow(scan_id, organization_id, providerName, result)
      )
      await insertVendorResults(organization_id, vendorRows)

      await completeScan(organization_id, scan_id, {
        riskScore,
        confidenceScore,
        verdict,
        durationMs: scanDurationMs,
      })

      return { scan_id, verdict, riskScore, confidenceScore }

    } catch (error) {
      await failScan(organization_id, scan_id, Date.now() - startTime)
      throw error
    }
  }
)
