// Gate 008A - Azure PostgreSQL data access for the scan product (replaces the Supabase service-role
// path in lib/data for the Azure runtime). Pure module: every function takes the transaction client
// it must use, so it runs unchanged against the real pool and a disposable test database.
//
// Invariants:
//   - Sign-in runs in a transaction WITHOUT tenant context (signInWithIdentity).
//   - Everything else runs inside runTenantTransaction: the database derives user and organization from
//     transaction-local settings, and row-level security filters every read. No function here accepts or
//     sends an organization id to SQL.
//   - Writes go only through SECURITY DEFINER functions (005: app_create_scan, app_mark_scan_processing;
//     004: app_record_fast_scan_result). The runtime role has no direct INSERT/UPDATE/DELETE on scans,
//     evidence, vendor results, audit log or organizations.
//   - Every value is a bound parameter.
import type { Queryable, TenantContext } from "../db/transaction"

export type VerifiedIdentity = {
  issuer: string        // from a verified ID token; must be in trusted_identity_issuers
  subject: string       // the token's immutable subject ("sub", or "oid" for Entra)
  email: string | null  // informational only; never used to link accounts
  displayName: string | null
}

export type SignInResult = TenantContext & { role: string; created: boolean }

export async function signInWithIdentity(client: Queryable, identity: VerifiedIdentity): Promise<SignInResult> {
  const { rows } = await client.query(
    "SELECT o_user_id, o_organization_id, o_role, o_created FROM public.app_sign_in($1, $2, $3, $4)",
    [identity.issuer, identity.subject, identity.email, identity.displayName]
  )
  const r = rows[0]
  if (!r || typeof r.o_user_id !== "string" || typeof r.o_organization_id !== "string") {
    throw new Error("sign-in returned no account")
  }
  return { userId: r.o_user_id, organizationId: r.o_organization_id, role: String(r.o_role), created: r.o_created === true }
}

export type ScanInputType = "url" | "domain" | "email" | "header" | "signature" | "batch"

export async function createScan(client: Queryable, inputType: ScanInputType, rawInput: string): Promise<string> {
  const { rows } = await client.query("SELECT public.app_create_scan($1, $2) AS id", [inputType, rawInput])
  const id = rows[0]?.id
  if (typeof id !== "string") throw new Error("scan was not created")
  return id
}

// true: pending -> processing; false: already processing (replay). Terminal or foreign scans throw.
export async function markScanProcessing(client: Queryable, scanId: string): Promise<boolean> {
  const { rows } = await client.query("SELECT public.app_mark_scan_processing($1) AS changed", [scanId])
  return rows[0]?.changed === true
}

export type ScanRow = {
  id: string
  input_type: string
  raw_input: string
  status: string
  verdict: string | null
  risk_score: number | null
  confidence_score: number | null
  created_at: Date
  completed_at: Date | null
}

const SCAN_COLUMNS = "id, input_type, raw_input, status, verdict, risk_score, confidence_score, created_at, completed_at"

// Row-level security limits both reads to the context organization; a foreign or unknown id is null.
export async function getScan(client: Queryable, scanId: string): Promise<ScanRow | null> {
  const { rows } = await client.query(`SELECT ${SCAN_COLUMNS} FROM public.scans WHERE id = $1`, [scanId])
  return (rows[0] as ScanRow | undefined) ?? null
}

export async function listRecentScans(client: Queryable, limit = 20): Promise<ScanRow[]> {
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), 100)
  const { rows } = await client.query(`SELECT ${SCAN_COLUMNS} FROM public.scans ORDER BY created_at DESC LIMIT $1`, [n])
  return rows as ScanRow[]
}

export type EvidenceRow = { signal_type: string; severity: string; title: string; detail: string | null; score_impact: number }

export async function getScanEvidence(client: Queryable, scanId: string): Promise<EvidenceRow[]> {
  const { rows } = await client.query(
    "SELECT signal_type, severity, title, detail, score_impact FROM public.evidence_items WHERE scan_id = $1 ORDER BY created_at, id",
    [scanId]
  )
  return rows as EvidenceRow[]
}
