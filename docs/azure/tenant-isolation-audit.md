# Tenant Isolation Code Audit (Phase A.1)

> READ-ONLY AUDIT. No database, code, traffic, or data changes were made.
> Branch: audit/azure-current-state. HEAD: 6f05d11 (Gate 2H closed).
> Scope: enumerate how the app enforces tenant isolation today, what depends on
> Supabase Auth, and what Gate 002 must add. Findings are based on direct code
> inspection of the files cited.

## Executive summary (the headline finding)

CheckBeforeClick already enforces tenant isolation at the APPLICATION layer today,
before any database RLS exists. All privileged database access is funneled through a
single auditable chokepoint (lib/data/index.ts), every read/update is filtered by
organization_id, every insert stamps it unconditionally, and the organization
context is always derived from the authenticated user — never from client input.

This means Gate 002's job is to ADD a second, independent layer of defense
(database-enforced RLS), not to fix a broken first layer. The current posture is
strong; 002 makes it defense-in-depth.

## Architecture verified (Security Architect lens)

### Privileged access is centralized in ONE chokepoint
- lib/data/client.ts is the ONLY file that reads SUPABASE_SERVICE_ROLE_KEY
  (verified: a repo-wide search for that key returns only this file).
- It exports createPrivilegedClient() and is marked import "server-only"
  (cannot be bundled into client/browser code — the key cannot leak to the browser).
- createPrivilegedClient is called from exactly TWO files: its own definition and
  lib/data/index.ts (verified by repo-wide search). Nothing outside lib/data/
  uses the privileged client.

Result: every RLS-bypassing database operation in the entire app passes through
lib/data/index.ts. The tenant-isolation question reduces to that one file plus its
callers.

### The data chokepoint enforces org scoping on every operation
lib/data/index.ts declares explicit invariants in a header comment and the code
honors them throughout (all functions inspected):
- Every function takes orgId as its first parameter, except two documented cases.
- No function returns or accepts a raw privileged client (the db never escapes).
- Every read/update is filtered by organization_id; every insert stamps it.

Verified function-by-function:
- getUserOrgContext(authUserId) — resolves org context from the authenticated
  user id by reading users where id = authUserId. This is the trusted SOURCE of
  org context. (Exception #1, documented.)
- createScan — stamps organization_id: orgId on insert.
- markScanProcessing, completeScan, failScan — UPDATE filtered by both
  id and organization_id (cannot mutate another org's scan).
- insertEvidenceItems, insertVendorResults — stamp organization_id: orgId
  UNCONDITIONALLY ({ ...r, organization_id: orgId }), so a caller cannot mis-scope
  even by mistake.
- getScanById, getScanStatus, getEvidenceForScan, getVendorResultsForScan,
  getDashboardData — every read filtered by organization_id (child tables
  filtered by org independently, not merely via the parent scan).
- loadScanForProcessing(scanId) — worker entry point. Takes only scanId,
  reloads the scan row from the DB, and returns that row's organization_id for
  callers to use on subsequent writes. Org context is re-derived from trusted DB
  state, NOT from any event payload. (Exception #2, documented.)

### Callers always pass the authenticated org, never client input
- getUserOrgContext is called in four places (dashboard page, scan-detail page,
  scan-status API, scan API), each as getUserOrgContext(user.id) — always the
  authenticated user id.
- In the scan API, the resulting ctx.organizationId is passed into runFastPath
  (call site line 91-93) and onward to the data functions.
- A repo search for organization_id across app/ returns only uses tied to
  ctx.organizationId (the trusted context) — no route reads organization_id
  from request body, query, or params.

End-to-end chain (verified): authenticated user -> getUserOrgContext(user.id) ->
ctx.organizationId -> runFastPath / data functions -> each re-filters by org -> DB.
Client input never determines the organization at any layer.

### Current Supabase-Auth dependencies (what 003/identity migration must replace)
- Identity originates from Supabase Auth: callers obtain user (and user.id)
  from the Supabase session, then call getUserOrgContext(user.id).
- getUserOrgContext maps the auth user id to the users row via users.id
  (today users.id equals the Supabase auth user id).
- Replacement (later gate): identity comes from Entra External ID; the auth subject
  is resolved to an internal users row (via an identity-link / entra_subject
  column). The org-derivation logic (getUserOrgContext) stays the same shape;
  only its INPUT (how user.id is obtained and validated) changes.

## Product Manager lens

### Current user journey (as implemented)
- Sign-up/login: Supabase Auth. On first login, a users row + organizations
  row exist (one user is tied to one organization via users.organization_id).
- Onboarding: minimal; user lands on dashboard scoped to their single org.
- Scan submit: authenticated user -> org derived server-side -> scan created and
  stamped with that org.
- Scan results / status / evidence / dashboard: all read scoped to the user's org.
- History / watchlist / feedback: tables exist and are org-stamped at the data
  layer; UI maturity not assessed in this audit (code-level scoping is present).

### Where the product assumes one-user-one-org today
- users.organization_id is a single column: a user belongs to exactly one org.
- getUserOrgContext returns a single organizationId.
- No memberships table exists yet.

### What changes when memberships allows user-to-many-org
- getUserOrgContext must become "resolve the ACTIVE org for this user" (a user may
  have several). This implies an active-org concept (selected org / default org).
- UI may eventually need an org switcher; for MVP, a single active org per session
  is sufficient and keeps UX simple.

### Minimum tenant model for MVP (without overbuild)
- Introduce memberships(user_id, organization_id, role) with ONE row per user for
  now (preserves today's one-org behavior).
- Keep a single "active org" per session. Defer org-switching UI, invites, and
  multi-org dashboards until a real buyer needs them.
- Backend gains the future-proof shape; UX stays as simple as today.

### What stays backend-only / not user-exposed
- RLS, session-variable org scoping, the privileged-client chokepoint, and the
  worker re-derivation logic are all invisible to users. They should remain so.
- Do not expose raw org IDs, role internals, or cross-org constructs in the UI.

## CISO Buyer lens

### "How do you stop one customer seeing another customer's scans?" — answer TODAY
All data access goes through one server-only module that bypasses no tenant check:
every query is filtered by the organization derived from the authenticated user, and
writes stamp that organization so a request cannot place or read data in another
tenant. Background jobs re-derive the organization from trusted database state, not
from the job message. Org identity is never taken from client input.

### Answer AFTER Gate 002 (target)
The same application-layer enforcement, PLUS database-enforced Row-Level Security as
an independent second layer: even if an application query omitted its org filter, the
database itself would refuse cross-organization rows. Two independent layers must both
fail for a leak to occur.

### Audit evidence available / to add
- Today: audit_log table exists and is org-stamped at the data layer.
- To add for buyer-grade trust: confirm every privileged write emits an audit entry;
  document the chokepoint design; capture the RLS policies (002) as evidence.

### What would be unacceptable in a security review (and current status)
- Client-supplied org IDs trusted by the server -> NOT present (verified).
- Privileged key reachable from the browser -> NOT possible (server-only).
- Scattered privileged DB access -> NOT present (single chokepoint).
- No database-level isolation -> CURRENT GAP, closed by 002 (RLS).

### Language we can honestly use after 002 (no overclaiming)
- "Tenant data is isolated at both the application and database layers."
- "All privileged data access is centralized and org-scoped; background processing
  re-derives tenant context from trusted state."
- Do NOT claim compliance certifications (SOC 2, etc.) that do not exist.

## Required changes before / in Gate 002

1. Introduce memberships(user_id, organization_id, role) (one row per user to
   start). Decide the "active org" resolution rule.
2. Update getUserOrgContext to resolve the active org via memberships (keeping
   single-org behavior for MVP).
3. Add RLS to all tenant tables in Azure PostgreSQL, keyed off a per-request session
   variable (e.g. app.current_org_id) rather than auth.uid().
4. Set that session variable from the trusted ctx.organizationId on each
   request/connection, and in the worker from loadScanForProcessing's returned org.
5. Keep the application-layer chokepoint as the PRIMARY enforcement; RLS is the
   defense-in-depth backstop.

## Proposed 002 migration scope (schema)
- memberships table + FKs + indexes.
- Enable RLS on: organizations, users, scans, scan_cache, vendor_results,
  evidence_items, scan_feedback, audit_log, watchlist, alerts.
- RLS policies keyed off the session variable; no dependency on Supabase auth.
- A documented mechanism to SET the session variable per connection/request.

## Proposed app-layer enforcement scope (002)
- Set app.current_org_id on the privileged client connection from
  ctx.organizationId before queries (so RLS has the value).
- Verify the worker path sets it from loadScanForProcessing's org.
- Keep all existing org filters in lib/data/index.ts (belt-and-suspenders).

## Proposed test plan — proving zero cross-tenant access
1. Two orgs (A, B), each with a user and scans.
2. As user A, attempt to read B's scan by id -> expect not found / denied (app).
3. With RLS on, attempt the same with the app filter intentionally removed in a
   test harness -> expect the DATABASE to deny it (proves the second layer).
4. Attempt to insert/update into B while authenticated as A -> denied at both layers.
5. Worker: enqueue a job for B's scan with a forged org in the payload -> verify the
   worker ignores the payload org and uses the DB-derived org (write lands in B only,
   and only because the scan truly belongs to B).
6. Confirm child-table reads (evidence, vendor_results) cannot cross orgs.
7. Confirm no route accepts a client-supplied org id (regression test).
Pass criteria: zero cross-tenant read or write at the app layer AND, independently,
at the database layer.

## What is NOT done by this audit
- No database change, no RLS yet, no memberships yet, no Entra yet, no traffic
  move, no data import. This is enumeration and design input for Gate 002 only.
