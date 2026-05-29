import { inngest } from "../client"
import { createClient } from "@supabase/supabase-js"
import { normalizeScanTarget } from "@/lib/security/urlSafety"
import { checkGoogleWebRisk, withTimeout } from "@/lib/scan/googleWebRisk"
import {
  calculateRiskScore,
  calculateConfidence,
  buildWebRiskEvidence,
  type EvidenceItem,
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

      // Build evidence item using shared helper
      evidenceItems.push(buildWebRiskEvidence(scan_id, organization_id, webRisk))

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
