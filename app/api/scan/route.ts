import "server-only"
import { inngest } from "@/inngest/client"
import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { normalizeScanTarget } from "@/lib/security/urlSafety"
import { getFastProviders } from "@/lib/scan/providers"
import {
  calculateRiskScoreFromProviders,
  calculateConfidenceFromProviders,
  buildEvidenceItem,
  buildVendorResultRow,
} from "@/lib/scan/scanHelpers"
import {
  getUserOrgContext,
  createScan,
  markScanProcessing,
  failScan,
} from "@/lib/data"
import {
  recordFastScanResult,
  type FastScanVerdict,
} from "@/src/server/scan/recordFastScanResult"

const VALID_INPUT_TYPES = ["url", "domain", "email", "header", "signature", "batch"]
const FAST_PATH_TYPES = ["url", "domain"]
const MAX_INPUT_LENGTH = 10000

export async function POST(request: NextRequest) {
  try {
    // 1. Authenticate user via Supabase Auth
    const authClient = await createClient()
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // 2. Resolve organization context server-side - never trust client
    const ctx = await getUserOrgContext(user.id)

    if (!ctx) {
      return NextResponse.json(
        { error: "User profile not found. Please sign out and sign in again." },
        { status: 403 }
      )
    }

    // 3. Parse and validate request body
    let body: { input?: string; input_type?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid request format." }, { status: 400 })
    }

    const { input, input_type } = body

    // 4. Validate input_type
    if (!input_type || !VALID_INPUT_TYPES.includes(input_type)) {
      return NextResponse.json({ error: "Invalid input type." }, { status: 400 })
    }

    // 5. Validate raw_input
    if (!input || typeof input !== "string" || input.trim().length === 0) {
      return NextResponse.json({ error: "Please provide content to check." }, { status: 400 })
    }

    const cleanInput = input.trim()

    if (cleanInput.length > MAX_INPUT_LENGTH) {
      return NextResponse.json(
        { error: `Input too long. Maximum ${MAX_INPUT_LENGTH} characters allowed.` },
        { status: 400 }
      )
    }

    // 6. Create scan record
    const scanId = await createScan(ctx.organizationId, ctx.userId, input_type, cleanInput)

    if (!scanId) {
      return NextResponse.json(
        { error: "Failed to create scan. Please try again." },
        { status: 500 }
      )
    }

    // 7. Route to fast path or slow path
    if (FAST_PATH_TYPES.includes(input_type)) {
      return await runFastPath({
        scan_id: scanId,
        user_id: ctx.userId,
        organization_id: ctx.organizationId,
        raw_input: cleanInput,
        input_type,
      })
    }

    // 8. Slow path - Inngest for email/header/heavy types
    try {
      await inngest.send({
        name: "scan/requested",
        data: { scan_id: scanId },
      })
    } catch (inngestError) {
      console.error("Inngest send error:", inngestError)

      await failScan(ctx.organizationId, scanId)

      return NextResponse.json(
        {
          error: "Scan was created but could not be queued. Please try again.",
          scan_id: scanId,
        },
        { status: 502 }
      )
    }

    return NextResponse.json({ scan_id: scanId }, { status: 201 })

  } catch (error) {
    console.error("Scan route error:", error)
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    )
  }
}

// Fast synchronous path - runs all enabled fast providers in parallel
async function runFastPath({
  scan_id,
  user_id,
  organization_id,
  raw_input,
  input_type,
}: {
  scan_id: string
  user_id: string
  organization_id: string
  raw_input: string
  input_type: string
}) {
  const startTime = Date.now()

  try {
    await markScanProcessing(organization_id, scan_id)

    // SSRF validation
    const target = normalizeScanTarget(raw_input, input_type)

    if (!target.ok) {
      await recordFastScanResult({
        userId: user_id,
        organizationId: organization_id,
        scanId: scan_id,
        status: "complete",
        verdict: "unknown",
        riskScore: 0,
        confidenceScore: 10,
        aiExplanation: null,
        recommendedAction: null,
        scanDurationMs: Date.now() - startTime,
        vendorResults: [],
        evidenceItems: [
          {
            signalType: "invalid_target",
            severity: "info",
            title: "Target could not be safely scanned",
            detail: target.reason ?? "Input could not be parsed into a safe scan target.",
            scoreImpact: 0,
          },
        ],
      })

      return NextResponse.json(
        { scan_id, status: "complete", verdict: "unknown" },
        { status: 201 }
      )
    }

    // Get all enabled fast providers for this input type
    const providers = getFastProviders(input_type as "url" | "domain")

    // Run all providers in parallel - one failure never blocks others
    // Always use normalized URL and "url" type after normalization
    // This ensures domain inputs like "yahoo.com" are handled consistently
    const providerInput = target.normalizedUrl!
    const providerInputType = "url" as const

    const providerResults = await Promise.allSettled(
      providers.map((provider) =>
        provider.run(providerInput, providerInputType)
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

    // Calculate scores from all provider results
    const confidenceScore = calculateConfidenceFromProviders(results, providers.length)
    const { riskScore, verdict } = calculateRiskScoreFromProviders(results, confidenceScore)

    const scanDurationMs = Date.now() - startTime

    const evidenceRows = results.map(({ providerName, result }) =>
      buildEvidenceItem(scan_id, organization_id, providerName, result)
    )

    const vendorRows = results.map(({ providerName, result }) =>
      buildVendorResultRow(scan_id, organization_id, providerName, result)
    )

    const finalVerdict: FastScanVerdict =
      verdict === "safe" ||
      verdict === "suspicious" ||
      verdict === "dangerous" ||
      verdict === "unknown"
        ? verdict
        : "unknown"

    await recordFastScanResult({
      userId: user_id,
      organizationId: organization_id,
      scanId: scan_id,
      status: "complete",
      verdict: finalVerdict,
      riskScore,
      confidenceScore,
      aiExplanation: null,
      recommendedAction: null,
      scanDurationMs,
      vendorResults: vendorRows.map((row) => ({
        vendorName: row.vendor_name,
        verdict: row.verdict,
        rawResponse: row.raw_response,
        errorMessage: row.error_message,
        responseTimeMs: row.response_time_ms,
      })),
      evidenceItems: evidenceRows.map((row) => ({
        signalType: row.signal_type,
        severity: row.severity,
        title: row.title,
        detail: row.detail,
        scoreImpact: row.score_impact,
      })),
    })

    return NextResponse.json(
      { scan_id, status: "complete", verdict: finalVerdict },
      { status: 201 }
    )

  } catch (error) {
    console.error("Fast path error:", error)

    await failScan(organization_id, scan_id, Date.now() - startTime)

    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 })
}
