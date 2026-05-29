import "server-only"
import { inngest } from "@/inngest/client"
import { NextResponse, type NextRequest } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { normalizeScanTarget } from "@/lib/security/urlSafety"
import { checkGoogleWebRisk, withTimeout } from "@/lib/scan/googleWebRisk"
import {
  calculateRiskScore,
  calculateConfidence,
  buildWebRiskEvidence,
  type EvidenceItem,
} from "@/lib/scan/scanHelpers"

const VALID_INPUT_TYPES = ["url", "domain", "email", "header", "signature", "batch"]
const FAST_PATH_TYPES = ["url", "domain"]
const MAX_INPUT_LENGTH = 10000

export async function POST(request: NextRequest) {
  try {
    const authClient = await createClient()
    const {
      data: { user },
      error: authError,
    } = await authClient.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

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

    let body: { input?: string; input_type?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: "Invalid request format." }, { status: 400 })
    }

    const { input, input_type } = body

    if (!input_type || !VALID_INPUT_TYPES.includes(input_type)) {
      return NextResponse.json({ error: "Invalid input type." }, { status: 400 })
    }

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

    if (FAST_PATH_TYPES.includes(input_type)) {
      return await runFastPath({
        supabase,
        scan_id: scan.id,
        organization_id: userRecord.organization_id,
        raw_input: cleanInput,
        input_type,
      })
    }

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

    const target = normalizeScanTarget(raw_input, input_type)

    if (!target.ok) {
      const evidenceItems: EvidenceItem[] = [{
        scan_id,
        organization_id,
        signal_type: "invalid_target",
        severity: "info",
        title: "Target could not be safely scanned",
        detail: target.reason || "Input could not be parsed into a safe scan target.",
        score_impact: 0,
      }]

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
        .eq("organization_id", organization_id)

      return NextResponse.json(
        { scan_id, status: "complete", verdict: "unknown" },
        { status: 201 }
      )
    }

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

    const evidenceItems: EvidenceItem[] = [
      buildWebRiskEvidence(scan_id, organization_id, webRisk),
    ]

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

    const scanDurationMs = Date.now() - startTime

    await supabase.from("evidence_items").insert(evidenceItems)

    await supabase.from("vendor_results").insert({
      scan_id,
      organization_id,
      vendor_name: "google_web_risk",
      verdict: webRisk.flagged ? "dangerous" : webRisk.skipped ? "skipped" : "clean",
      raw_response: webRisk,
      error_message: webRisk.error || null,
      response_time_ms: scanDurationMs,
    })

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