// Org-scoped data-access chokepoint.
// INVARIANTS:
// - Every function takes orgId as its first parameter, EXCEPT:
//   - getUserOrgContext (resolves org context from the authenticated user id)
//   - loadScanForProcessing (worker entry point; reloads org context from
//     trusted DB state, never from event payload)
// - No function returns or accepts a raw privileged client.
// - Every read/update is filtered by organization_id; every insert stamps it.
import "server-only"
import { createPrivilegedClient } from "./client"

export type UserOrgContext = {
  userId: string
  organizationId: string
  role: string | null
  fullName: string | null
}

export async function getUserOrgContext(
  authUserId: string
): Promise<UserOrgContext | null> {
  const db = createPrivilegedClient()
  const { data, error } = await db
    .from("users")
    .select("id, organization_id, role, full_name")
    .eq("id", authUserId)
    .single()

  if (error || !data || !data.organization_id) return null

  return {
    userId: data.id,
    organizationId: data.organization_id,
    role: data.role ?? null,
    fullName: data.full_name ?? null,
  }
}

// ---------- Scan lifecycle ----------

export async function createScan(
  orgId: string,
  userId: string,
  inputType: string,
  rawInput: string
): Promise<string | null> {
  const db = createPrivilegedClient()
  const { data, error } = await db
    .from("scans")
    .insert({
      organization_id: orgId,
      user_id: userId,
      input_type: inputType,
      raw_input: rawInput,
      status: "pending",
    })
    .select("id")
    .single()

  if (error || !data) {
    console.error("Scan insert error:", error)
    return null
  }
  return data.id
}

export async function markScanProcessing(orgId: string, scanId: string) {
  const db = createPrivilegedClient()
  await db
    .from("scans")
    .update({ status: "processing" })
    .eq("id", scanId)
    .eq("organization_id", orgId)
}

export async function completeScan(
  orgId: string,
  scanId: string,
  result: {
    riskScore: number
    confidenceScore: number
    verdict: string
    durationMs: number
  }
) {
  const db = createPrivilegedClient()
  await db
    .from("scans")
    .update({
      status: "complete",
      risk_score: result.riskScore,
      confidence_score: result.confidenceScore,
      verdict: result.verdict,
      completed_at: new Date().toISOString(),
      scan_duration_ms: result.durationMs,
    })
    .eq("id", scanId)
    .eq("organization_id", orgId)
}

// durationMs omitted => status-only failure (Inngest enqueue failure path).
// durationMs provided => failure with completed_at + duration (processing failure paths).
export async function failScan(orgId: string, scanId: string, durationMs?: number) {
  const db = createPrivilegedClient()
  const update: Record<string, unknown> =
    durationMs === undefined
      ? { status: "failed" }
      : {
          status: "failed",
          completed_at: new Date().toISOString(),
          scan_duration_ms: durationMs,
        }
  await db.from("scans").update(update).eq("id", scanId).eq("organization_id", orgId)
}

// ---------- Evidence / vendor writes ----------
// Rows may arrive with or without organization_id (scanHelpers builders include it);
// the module stamps orgId unconditionally so callers cannot mis-scope.

export async function insertEvidenceItems(
  orgId: string,
  rows: Record<string, unknown>[]
) {
  if (rows.length === 0) return
  const db = createPrivilegedClient()
  await db
    .from("evidence_items")
    .insert(rows.map((r) => ({ ...r, organization_id: orgId })))
}

export async function insertVendorResults(
  orgId: string,
  rows: Record<string, unknown>[]
) {
  if (rows.length === 0) return
  const db = createPrivilegedClient()
  await db
    .from("vendor_results")
    .insert(rows.map((r) => ({ ...r, organization_id: orgId })))
}

// ---------- Reads ----------

export async function getScanById(orgId: string, scanId: string) {
  const db = createPrivilegedClient()
  const { data, error } = await db
    .from("scans")
    .select("*")
    .eq("id", scanId)
    .eq("organization_id", orgId)
    .single()

  if (error || !data) return null
  return data
}

export async function getScanStatus(
  orgId: string,
  scanId: string
): Promise<{ status: string; verdict: string | null } | null> {
  const db = createPrivilegedClient()
  const { data, error } = await db
    .from("scans")
    .select("status, verdict")
    .eq("id", scanId)
    .eq("organization_id", orgId)
    .single()

  if (error || !data) return null
  return { status: data.status, verdict: data.verdict }
}

export async function getEvidenceForScan(orgId: string, scanId: string) {
  const db = createPrivilegedClient()
  const { data } = await db
    .from("evidence_items")
    .select("*")
    .eq("scan_id", scanId)
    .eq("organization_id", orgId)
    .order("score_impact", { ascending: false })
  return data ?? []
}

export async function getVendorResultsForScan(orgId: string, scanId: string) {
  const db = createPrivilegedClient()
  const { data } = await db
    .from("vendor_results")
    .select("*")
    .eq("scan_id", scanId)
    .eq("organization_id", orgId)
  return data ?? []
}

export async function getDashboardData(orgId: string) {
  const db = createPrivilegedClient()

  const { data: completedScans } = await db
    .from("scans")
    .select("verdict, created_at")
    .eq("organization_id", orgId)
    .eq("status", "complete")

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString()
  const { count: weekCount } = await db
    .from("scans")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .gte("created_at", sevenDaysAgo)

  const { data: recentScans } = await db
    .from("scans")
    .select("id, raw_input, input_type, verdict, status, created_at, risk_score")
    .eq("organization_id", orgId)
    .order("created_at", { ascending: false })
    .limit(10)

  return {
    completedScans: completedScans ?? [],
    weekCount: weekCount ?? 0,
    recentScans: recentScans ?? [],
  }
}

// ---------- Worker entry point (invariant 6) ----------
// The ONLY function that takes a bare scanId without orgId: it exists to
// reload org context from the database. Callers must use the returned
// organization_id for all subsequent writes.

export async function loadScanForProcessing(scanId: string): Promise<{
  id: string
  organization_id: string | null
  raw_input: string
  input_type: string
} | null> {
  const db = createPrivilegedClient()
  const { data, error } = await db
    .from("scans")
    .select("id, organization_id, raw_input, input_type")
    .eq("id", scanId)
    .single()

  if (error || !data) return null
  return data
}
