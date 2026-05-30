import "server-only"
import { inngest } from "@/inngest/client"
import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { normalizeScanTarget } from "@/lib/security/urlSafety"
import { getFastProviders } from "@/lib/scan/providers"
import {
  calculateRiskScoreFromProviders,
  calculateConfidenceFromProviders,
  buildEvidenceItem,
  buildVendorResultRow,
} from "@/lib/scan/scanHelpers"

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

    // 2. Get organization_id from database — never trust client
    const supabase = createServiceClient()
    const { data: userRecord, error: userError } = await supabase
      .from("users")
      .select("id, organization_id, role")
      .eq("id", user.id)
      .single()

    if (userError || !userRecord) {
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
    const { data: scan, error: scanError } = await supabase
      .from("scans")
      .insert({
        organization_id: userRecord.organization_id,
        user_id: userRecord.id,
        input_type,
        raw_input: cleanInput,
        status: "pending",
      })
      .select("id")
      .single()

    if (scanError || !scan) {
      console.error("Scan insert error:", scanError)
      return NextResponse.json(
        { error: "Failed to create scan. Please try again." },
        { status: 500 }
      )
    }

    // 7. Route to fast path or slow path
    if (FAST_PATH_TYPES.includes(input_type)) {
      return await runFastPath({
        supabase,
        scan_id: scan.id,
        organization_id: userRecord.organization_id,
        raw_input: cleanInput,
        input_type,
      })
    }

    // 8. Slow path — Inngest for email/header/heavy types
    try {
      await inngest.send({
        name: "scan/requested",
        data: { scan_id: scan.id },
      })
    } catch (inngestError) {
      console.error("Inngest send error:", inngestError)

      await supabase
        .from("scans")
        .update({ status: "failed" })
        .eq("id", scan.id)
        .eq("organization_id", userRecord.organization_id)

      return NextResponse.json(
        {
          error: "Scan was created but could not be queued. Please try again.",
          scan_id: scan.id,
        },
        { status: 502 }
      )
    }

    return NextResponse.json({ scan_id: scan.id }, { status: 201 })

  } catch (error) {
    console.error("Scan route error:", error)
    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    )
  }
}

// Fast synchronous path — runs all enabled fast providers in parallel
async function runFastPath({
  supabase,
  scan_id,
  organization_id,
  raw_input,
  input_type,
}: {
  supabase: ReturnType<typeof createServiceClient>
  scan_id: string
  organization_id: string
  raw_input: string
  input_type: string
}) {
  const startTime = Date.now()

  try {
    await supabase
      .from("scans")
      .update({ status: "processing" })
      .eq("id", scan_id)
      .eq("organization_id", organization_id)

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
        .eq("organization_id", organization_id)

      return NextResponse.json(
        { scan_id, status: "complete", verdict: "unknown" },
        { status: 201 }
      )
    }

    // Get all enabled fast providers for this input type
    const providers = getFastProviders(input_type as "url" | "domain")

    // Run all providers in parallel — one failure never blocks others
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
    const { riskScore, verdict } = calculateRiskScoreFromProviders(results)
    const confidenceScore = calculateConfidenceFromProviders(results, providers.length)

    const scanDurationMs = Date.now() - startTime

    // Write evidence_items — one row per provider
    const evidenceRows = results.map(({ providerName, result }) =>
      buildEvidenceItem(scan_id, organization_id, providerName, result)
    )
    if (evidenceRows.length > 0) {
      await supabase.from("evidence_items").insert(evidenceRows)
    }

    // Write vendor_results — one row per provider
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
      .eq("organization_id", organization_id)

    return NextResponse.json(
      { scan_id, status: "complete", verdict },
      { status: 201 }
    )

  } catch (error) {
    console.error("Fast path error:", error)

    await supabase
      .from("scans")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        scan_duration_ms: Date.now() - startTime,
      })
      .eq("id", scan_id)
      .eq("organization_id", organization_id)

    return NextResponse.json(
      { error: "An unexpected error occurred. Please try again." },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 })
}