import { inngest } from "../client"
import { normalizeScanTarget } from "@/lib/security/urlSafety"
import { getFastProviders, getAsyncProviders, withoutPaidProviders } from "@/lib/scan/providers"
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
import { processScanJob } from "@/lib/scan/workerFlow"

// Gate 007A: nothing sends "scan/requested" any more (every scan runs in the signed-in request). This job remains
// for events queued before the deploy and for manual re-runs. The flow lives in lib/scan/workerFlow.ts (pure,
// tested offline): terminal scans are skipped, paid providers never run here, errors fail the scan and rethrow.
export const processScan = inngest.createFunction(
  {
    id: "process-scan",
    retries: 1,
    triggers: [{ event: "scan/requested" }],
  },
  async ({ event }) =>
    processScanJob(
      {
        loadScan: loadScanForProcessing,
        markProcessing: markScanProcessing,
        normalizeTarget: normalizeScanTarget,
        // Never a paid provider here (workerFlow filters again, independently).
        getProviders: (hasUrl, inputType) =>
          withoutPaidProviders(hasUrl ? getFastProviders("url") : getAsyncProviders(inputType as "email" | "header")),
        scoring: {
          confidence: calculateConfidenceFromProviders,
          risk: calculateRiskScoreFromProviders,
          evidence: buildEvidenceItem,
          vendor: buildVendorResultRow,
        },
        insertEvidence: insertEvidenceItems,
        insertVendorResults,
        completeScan,
        failScan,
        now: () => Date.now(),
      },
      event.data?.scan_id
    )
)
