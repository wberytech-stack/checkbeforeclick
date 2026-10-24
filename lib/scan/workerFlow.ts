// Gate 007A - the Inngest "process-scan" job (inngest/functions/processScan.ts) as a pure flow.
// Pure module: type-only imports, no env vars, no I/O. Every effect is injected, so the worker contract is testable
// offline (scripts/rate-limit/test-worker-flow.ts).
//
// Since Gate 007A nothing in this code base sends "scan/requested": every scan is processed in the signed-in request
// (lib/scan/scanFlow.ts). The worker stays registered only for events queued before the deploy and for manual
// re-runs from the Inngest dashboard. Its contract:
//   - the scan and its organization are reloaded from the database; the event payload is trusted for the id only;
//   - a scan that is already terminal (complete / failed) is left untouched: replays and re-runs are no-ops, so a
//     finished verdict is never overwritten and evidence is never duplicated;
//   - paid providers are never run here (filtered by this module itself, whatever the registry returns);
//   - input handling is unchanged from master: email/header/signature/batch use the first http(s) URL in the text;
//     no safe URL -> complete / unknown with an invalid_target evidence row;
//   - any error marks the scan failed and is rethrown, so Inngest applies its retry (retries: 1).
import type { ScanProvider, ScanProviderResult } from "@/lib/scan/providers/types"
import type { EvidenceItem, VendorResultRow } from "@/lib/scan/scanHelpers"

type ProviderEntry = { providerName: string; result: ScanProviderResult }

export type WorkerScan = {
  id: string
  organization_id: string | null
  raw_input: string
  input_type: string
  status: string | null
}

export type WorkerDeps = {
  loadScan: (scanId: string) => Promise<WorkerScan | null>
  markProcessing: (orgId: string, scanId: string) => Promise<void>
  normalizeTarget: (rawInput: string, inputType: string) => { ok: boolean; normalizedUrl?: string; reason?: string }
  getProviders: (hasUrl: boolean, inputType: string) => ScanProvider[]
  scoring: {
    confidence: (results: ProviderEntry[], totalProviders: number) => number
    risk: (results: ProviderEntry[], confidenceScore: number) => { riskScore: number; verdict: string }
    evidence: (scanId: string, orgId: string, providerName: string, result: ScanProviderResult) => EvidenceItem
    vendor: (scanId: string, orgId: string, providerName: string, result: ScanProviderResult) => VendorResultRow
  }
  insertEvidence: (orgId: string, rows: Record<string, unknown>[]) => Promise<void>
  insertVendorResults: (orgId: string, rows: Record<string, unknown>[]) => Promise<void>
  completeScan: (orgId: string, scanId: string, r: { riskScore: number; confidenceScore: number; verdict: string; durationMs: number }) => Promise<void>
  failScan: (orgId: string, scanId: string, durationMs: number) => Promise<void>
  now: () => number
}

export type WorkerResult =
  | { scan_id: string; skipped: true; reason: string }
  | { scan_id: string; verdict: string; reason?: string; riskScore?: number; confidenceScore?: number }

export const TERMINAL_STATUSES = ["complete", "failed"]

export async function processScanJob(deps: WorkerDeps, scanId: unknown): Promise<WorkerResult> {
  if (typeof scanId !== "string" || scanId.length === 0) throw new Error("scan/requested event without a scan_id")
  const startTime = deps.now()

  // Reload scan + org context from the database; never trust the event payload beyond the id.
  const scan = await deps.loadScan(scanId)
  if (!scan) throw new Error(`Could not load scan record for scan_id: ${scanId}`)
  if (!scan.organization_id) throw new Error(`Scan ${scanId} has no organization_id - cannot proceed`)

  if (scan.status !== null && TERMINAL_STATUSES.includes(scan.status)) {
    return { scan_id: scanId, skipped: true, reason: `scan already ${scan.status}` }
  }

  const orgId = scan.organization_id
  await deps.markProcessing(orgId, scanId)

  try {
    const target = deps.normalizeTarget(scan.raw_input, scan.input_type)

    if (!target.ok || !target.normalizedUrl) {
      await deps.insertEvidence(orgId, [
        {
          scan_id: scanId,
          signal_type: "invalid_target",
          severity: "info",
          title: "Target could not be safely scanned",
          detail: target.reason ?? "Input could not be parsed into a safe scan target.",
          score_impact: 0,
        },
      ])
      await deps.completeScan(orgId, scanId, { riskScore: 0, confidenceScore: 10, verdict: "unknown", durationMs: deps.now() - startTime })
      return { scan_id: scanId, verdict: "unknown", reason: target.reason }
    }

    // Never a paid provider here: delayed, retried, duplicated or replayed runs must not reach Google Web Risk.
    const providers = deps.getProviders(true, scan.input_type).filter((p) => p.paid !== true)

    if (providers.length === 0) {
      await deps.completeScan(orgId, scanId, { riskScore: 0, confidenceScore: 10, verdict: "unknown", durationMs: deps.now() - startTime })
      return { scan_id: scanId, verdict: "unknown", reason: "No providers available for this input" }
    }

    const settled = await Promise.allSettled(providers.map((p) => p.run(target.normalizedUrl as string, "url")))
    const results: ProviderEntry[] = providers.map((p, i) => {
      const s = settled[i]
      return {
        providerName: p.name,
        result:
          s.status === "fulfilled"
            ? s.value
            : {
                verdict: "error" as const,
                error: "Provider threw unexpectedly",
                scoreImpact: 0,
                confidenceImpact: -10,
                evidenceTitle: `${p.displayName} check failed`,
                evidenceDetail: "An unexpected error occurred.",
                evidenceSeverity: "info" as const,
                rawResponse: null,
                responseTimeMs: 0,
              },
      }
    })

    const confidenceScore = deps.scoring.confidence(results, providers.length)
    const { riskScore, verdict } = deps.scoring.risk(results, confidenceScore)

    await deps.insertEvidence(orgId, results.map(({ providerName, result }) => deps.scoring.evidence(scanId, orgId, providerName, result)))
    await deps.insertVendorResults(orgId, results.map(({ providerName, result }) => deps.scoring.vendor(scanId, orgId, providerName, result)))
    await deps.completeScan(orgId, scanId, { riskScore, confidenceScore, verdict, durationMs: deps.now() - startTime })

    return { scan_id: scanId, verdict, riskScore, confidenceScore }
  } catch (error) {
    await deps.failScan(orgId, scanId, deps.now() - startTime)
    throw error
  }
}
