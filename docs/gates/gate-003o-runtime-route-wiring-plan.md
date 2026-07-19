# Gate 003O - Runtime Route Wiring Plan

## 1. Gate status

Plan only. No runtime code is changed in this gate. No route files are
modified. No database migrations are applied. No Azure, Key Vault,
production database, package files, or deployment config are touched.

## 2. Background

Gates 003D through 003N established the full database-side tenant-boundary
enforcement path:

- Gate 003D Slice 1: boundary-only stub function with SECURITY DEFINER,
  locked search_path, transaction-local GUC context, and fail-closed
  tenant checks.
- Gate 003G: server-only PostgreSQL transaction helper (withPgTransaction)
  using pg, singleton pool cached on globalThis, BEGIN/COMMIT/ROLLBACK
  on a single PoolClient.
- Gate 003H: disposable local validation of the transaction helper,
  including T3 confirmation that set_config(..., true) is visible on the
  same client within the same transaction.
- Gate 003M: expanded migration 004 replacing the stub with a full write
  implementation that updates scans, inserts vendor_results, and inserts
  evidence_items atomically after all tenant and payload checks pass.
- Gate 003N: disposable local validation of migration 004, 41 tests all
  passing, including T38 rollback after post-UPDATE failure, T39/T40
  one-shot completion rule, and T41 GUC no-leak.

Migration 004 has NOT been applied to cbc_prod, Azure PostgreSQL, or any
real database. This plan is the prerequisite for that apply and for any
runtime route wiring.

## 3. Current /api/scan write behavior

The current scan route (app/api/scan/route.ts) writes scan results using
the Supabase service-role data-access pattern via lib/data/index.ts
helpers:

- createScan
- markScanProcessing
- insertEvidenceItems
- insertVendorResults
- completeScan
- failScan

These helpers call createPrivilegedClient() from lib/data/client.ts, which
uses SUPABASE_SERVICE_ROLE_KEY with @supabase/supabase-js. This pattern
does not provide a way to guarantee that set_config(..., true) calls and
a DB function call share one physical connection and one transaction
boundary. That gap was documented in Gate 003E and confirmed in Gate 003F.

The future path replaces the final scan persistence step only. It does not
remove or replace all Supabase usage in the route at this time. Supabase
Auth (createClient().auth.getUser()) and org context resolution
(getUserOrgContext(user.id)) remain unchanged.

## 4. Target transaction flow

The future runtime scan write path must execute the following as one
transaction on one physical connection, with no other statements
interleaved:

Step 1: Resolve user_id and organization_id server-side from the verified
session state. These values must come from Supabase Auth and server-side
org context resolution. They must never come from client-supplied input
or from the request body.

Step 2: Open one transaction using withPgTransaction from
src/server/db/postgres.ts.

Step 3: Inside the callback, on the same PoolClient, set both
transaction-local GUCs:

  await client.query(
    "SELECT set_config('app.current_user_id', $1, true)",
    [userId]
  );
  await client.query(
    "SELECT set_config('app.current_organization_id', $1, true)",
    [orgId]
  );

Step 4: On the same PoolClient, call the DB function:

  await client.query(
    "SELECT public.app_record_fast_scan_result($1::uuid,$2::text,$3::text,$4::integer,$5::integer,$6::text,$7::text,$8::integer,$9::jsonb,$10::jsonb,$11::text) AS scan_id",
    [
      scanId,       -- p_scan_id
      status,       -- p_status (complete or failed)
      verdict,      -- p_verdict
      riskScore,    -- p_risk_score
      confidenceScore, -- p_confidence_score
      aiExplanation,   -- p_ai_explanation
      recommendedAction, -- p_recommended_action
      scanDurationMs,  -- p_scan_duration_ms
      vendorResultsJson, -- p_vendor_results (jsonb)
      evidenceItemsJson, -- p_evidence_items (jsonb)
      errorMessage     -- p_error_message
    ]
  );

Step 5: withPgTransaction issues COMMIT on success or ROLLBACK on any
exception. The caller receives either the scan_id return value or a
mapped error.

organization_id must never appear as a direct argument to
app_record_fast_scan_result. It reaches the function only through the
set_config call in Step 3. The DB function reads it via
app_current_org_id() which calls current_setting('app.current_organization_id', true).
## 5. JSONB payload mapping

Migration 004 expects p_vendor_results and p_evidence_items as JSONB
arrays. The current route produces per-provider results via
getFastProviders(...) and Promise.allSettled(...). The runtime must map
those results into the JSONB shapes before calling the function.

p_vendor_results shape (one object per provider):

  {
    "vendor_name":      string  (required)
    "verdict":          string  (optional)
    "raw_response":     object  (optional)
    "error_message":    string  (optional)
    "response_time_ms": integer (optional)
  }

p_evidence_items shape (one object per evidence signal):

  {
    "signal_type":  string  (required)
    "severity":     string  (required, one of:
                            critical/high/medium/low/info/good)
    "title":        string  (required)
    "detail":       string  (optional)
    "score_impact": integer (optional, defaults to 0)
  }

Mapping rules:

- vendor_name must be a non-empty string identifying the provider.
- verdict must match the scans.verdict constraint (safe/suspicious/
  dangerous/unknown) or be omitted.
- raw_response must be a JSON-serializable object or omitted.
- response_time_ms must be an integer >= 0 or omitted.
- severity must be one of the six allowed values enforced by migration
  004's validation loop. Any severity value outside that set will cause
  the function to raise an exception before any writes occur.
- score_impact must be an integer or omitted; the function defaults it
  to 0 if absent.

The runtime must build these arrays before calling withPgTransaction.
JSON.stringify is used to produce the JSONB string passed as a parameter.
The DB function's per-element validation loop is the authoritative
validation point. App-side mapping is defense-in-depth only.

## 6. Role and credential requirements

The transaction helper (src/server/db/postgres.ts) connects using
CBC_DATABASE_URL. The role identified by that connection string is the
runtime role for this call path.

Requirements:
- The runtime role must have EXECUTE on
  public.app_record_fast_scan_result(...) with the 11-parameter signature
  from migration 004.
- The runtime role must NOT be cbcpgadmin.
- The runtime role must NOT use SUPABASE_SERVICE_ROLE_KEY.
- The runtime role must NOT be a superuser.
- The runtime role should be cbc_app or an equivalent least-privileged
  role with the EXECUTE grant landed by migration 004's conditional grant.
- SUPABASE_SERVICE_ROLE_KEY continues to be used only for the existing
  Supabase data-access helpers that are not being replaced in this gate.

Environment variables required:
- CBC_DATABASE_URL: connection string for the server-only pg pool.
  Must point to the target database. Must be server-only. Must never be
  client-bundled.
- CBC_DATABASE_SSL: set to false for local disposable validation only.
  Must not be set to false in any real environment.

The cbc_app role's existence and EXECUTE grant in the target database
must be confirmed before any non-disposable apply. This was listed as
an open question in Gate 003E and has not been resolved.

## 7. Failure and rollback behavior

The DB function fails closed with RAISE EXCEPTION for:
- Missing app.current_user_id or app.current_organization_id.
- Scan not found.
- Cross-tenant scan access.
- Caller not a member of the scan organization.
- Scan already in a final state (one-shot completion rule).
- Invalid p_status (not complete or failed).
- Any payload validation failure.

The runtime must:
- Let withPgTransaction catch any exception and issue ROLLBACK
  automatically. No manual ROLLBACK is needed in the route handler.
- Map DB exceptions to appropriate HTTP responses without leaking the
  raw RAISE EXCEPTION message text to the client.
- Never automatically retry a call that failed due to a tenant-boundary
  refusal or one-shot rejection. These are not transient failures.
- Retry only on transient connection-level failures, using normal
  backend retry practice, which is separate from tenant-boundary
  refusals.
- Log the scan_id, user_id, organization_id, outcome, and timestamp
  server-side on every call. Never log the connection string or raw DB
  exception text to any client-visible surface.

## 8. Partial migration period behavior

During the transition, the route may still call the existing Supabase
helpers for some steps (createScan, markScanProcessing) while calling
the new DB function for the final persistence step (replacing
completeScan, failScan, insertVendorResults, insertEvidenceItems).

Rules for the partial migration period:
- The existing Supabase helpers and the new pg transaction path must not
  both write final scan state for the same scan in the same request.
- createScan and markScanProcessing may continue using the existing
  Supabase path until a future gate replaces them.
- The new pg transaction path is the authoritative final write for scan
  status, verdict, vendor_results, and evidence_items.
- If the pg transaction fails, the scan remains in processing state.
  The existing Supabase failScan helper must not be called as a fallback
  in a way that bypasses the DB function's tenant checks.
- Supabase Auth and org context resolution are not changed in this gate
  or in the initial wiring gate.
## 9. Required environment and infrastructure prerequisites

The following must be true before any non-disposable migration apply or route wiring begins:

- Migration 004 applied to the target database. Not applied to cbc_prod
  or Azure PostgreSQL as of Gate 003N closure. A separate apply runbook
  gate is required.
- cbc_app role exists in the target database with EXECUTE granted on
  public.app_record_fast_scan_result with the 11-parameter signature.
- CBC_DATABASE_URL set in the server environment pointing to the target
  database, using the cbc_app credential.
- CBC_DATABASE_URL confirmed server-only and not client-bundled.
- The runtime environment confirmed as Node.js, not Edge runtime. The
  pg client requires a real TCP connection and cannot run in Edge
  runtime. This was established in Gate 003G.
- The cbcpgadmin / Key Vault credential mismatch remains unresolved and
  must not block or be conflated with this gate. It is a separate item.

## 10. Out of scope for this gate and the initial wiring gate

- No changes to app/api/scan/route.ts in this planning gate.
- No changes to lib/data/index.ts or lib/data/client.ts.
- No removal of SUPABASE_SERVICE_ROLE_KEY or Supabase client usage.
- No changes to Supabase Auth or getUserOrgContext.
- No new package dependencies beyond pg, server-only, and @types/pg
  which are already installed from Gate 003G.
- No Azure infrastructure changes.
- No Key Vault changes.
- No cbc_prod or Azure PostgreSQL changes in this gate.
- No deployment config changes.
- No audit_log writes. Audit writes are deferred to a future gate after
  the audit event shape, action names, metadata schema, and IP handling
  are decided. Migration 004 explicitly does not write to audit_log.
- No changes to the browser extension or any frontend code.
- No changes to any other API route.

## 11. Implementation sequencing for the wiring gate

Gate 003O is plan only. The following sequencing applies to the
subsequent implementation gate (Gate 003P or equivalent):

1. Implement the JSONB mapping functions and the server-only pg
   transaction helper for calling
   public.app_record_fast_scan_result(...). Keep this isolated from the
   route handler. No migration apply and no route wiring in this step.
2. Validate the helper against a disposable local PostgreSQL database
   only, including the set_config(...) GUC sequence and
   app_record_fast_scan_result(...) call, before any non-disposable
   environment is involved.
3. Prepare a separate non-disposable migration 004 apply runbook gate.
   Document the exact apply steps, the target environment, the role
   setup verification, and the rollback plan.
4. Apply migration 004 to the target database only after explicit
   founder and ChatGPT approval of the apply runbook. Do not apply
   migration 004 and wire the route in the same PR.
5. Verify after the migration apply: cbc_app role exists, EXECUTE grant
   is present on the 11-parameter signature, and CBC_DATABASE_URL is
   confirmed pointing to the correct target.
6. Wire app/api/scan/route.ts to call the new helper function only after
   steps 4 and 5 are complete and verified. Replace completeScan,
   failScan, insertVendorResults, and insertEvidenceItems for the
   fast-path completion step only.
7. Validate end-to-end against a disposable local PostgreSQL database
   before any non-disposable route wiring.
8. Do not merge any route wiring PR until the disposable validation
   passes and ChatGPT plus founder have reviewed the diff.

## 12. Open questions before implementation

- Has cbc_app been created in the target database with the correct
  EXECUTE grant? Not confirmed as of Gate 003N.
- What is the exact CBC_DATABASE_URL value for the target database?
  Not set in any environment as of Gate 003N.
- Is the Node.js runtime confirmed for the route handler in the target
  deployment environment (Azure Container Apps)? Assumed yes based on
  Gate 003G documentation but not explicitly verified against the actual
  deployment config.
- What HTTP status codes and error shapes should the route return for
  each DB exception type (cross-tenant, one-shot rejection, missing
  context, scan not found)? Product decision, not yet made.
- Should createScan and markScanProcessing be migrated to the pg path
  in the same wiring gate, or only the final persistence step? Scope
  decision, not yet made.
- When is the audit_log write gate planned, and does the route wiring
  gate need to leave a hook for it or can it be added later without
  a route change?
- The cbcpgadmin / Key Vault credential mismatch: what is the current
  status and does it affect the cbc_app credential path?
## 13. Acceptance criteria for this gate

This planning gate is accepted when:

- docs/gates/gate-003o-runtime-route-wiring-plan.md exists and covers
  all required sections.
- The target transaction flow in Section 4 is documented with the exact
  GUC set_config call sequence and function call parameter order.
- organization_id is confirmed absent from the function argument list
  in the documented call.
- The JSONB payload mapping shapes in Section 5 match the schemas
  documented in migration 004.
- The role and credential requirements in Section 6 explicitly exclude
  cbcpgadmin and SUPABASE_SERVICE_ROLE_KEY from the new path.
- The failure and rollback behavior in Section 7 correctly describes
  withPgTransaction's automatic ROLLBACK on exception.
- The partial migration period rules in Section 8 are documented.
- All prerequisites in Section 9 are listed and none are marked as
  confirmed unless they have been explicitly verified.
- The out-of-scope list in Section 10 is present and complete.
- The implementation sequencing in Section 11 requires disposable local
  validation before any route wiring PR is merged.
- The open questions in Section 12 are listed and none are assumed
  resolved without explicit confirmation.
- No app code, migration files, package files, route files, or
  environment files are changed in this gate.
- ChatGPT and founder have both reviewed this document before any
  implementation gate begins.
