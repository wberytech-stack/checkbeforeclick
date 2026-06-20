# Gate 002 - Tenant Isolation Design (v2, amended)

> DESIGN ONLY. No migration file, no database change, no app change, no traffic
> move, no data import. v2 incorporates ChatGPT's approved amendments (FK behavior,
> require-membership policies, controlled bootstrap, transaction-bound context,
> keep users.organization_id) PLUS a new runtime DB role separation requirement.
> Branch: audit/azure-current-state. Builds on Phase A.1 audit (5a6d5af) and the
> v1 design (9e6ee86). No secrets in this document.

## 0. Context

Phase A.1 verified app-layer isolation is already strong (single privileged
chokepoint in lib/data, all reads/updates org-scoped, inserts stamp org server-side,
no route trusts client org, org from authenticated user, worker re-derives org from
DB). cbc_prod holds the 001 baseline (10 tables, no RLS, no memberships). 002 ADDS a
database-enforced second wall. It is permanent work, not a patch, and it does NOT by
itself make the product "fully Azure-native" or "SSO-enabled" (separate later gates).

## 1. Final purpose of 002

- Introduce memberships (user-to-organization relationship + role).
- Preserve current one-org-per-user behavior initially (no UX change).
- Prepare for future multi-org / MSP capability without another tenant-model migration.
- Add database-level RLS as an independent second wall, keyed off app-set session
  variables - NOT auth.uid(), NOT Supabase Auth.
- Ensure RLS is actually effective by running the app under a least-privileged
  runtime role that cannot bypass RLS (see Section 12 - critical).

## 2. Proposed schema changes

### 2.1 memberships table
- id              uuid primary key default gen_random_uuid()
- user_id         uuid not null
- organization_id uuid not null
- role            text not null default 'member'
- created_at      timestamptz not null default now()
- updated_at      timestamptz not null default now()

Constraints / indexes:
- UNIQUE (user_id, organization_id)
- CHECK (role IN ('owner','admin','member','viewer'))   (only admin/member used at MVP)
- index on (user_id)
- index on (organization_id)

FK behavior (CONFIRMED by ChatGPT):
- user_id -> users(id) ON DELETE CASCADE
  (deleting a user removes their membership rows)
- organization_id -> organizations(id) ON DELETE RESTRICT
  (an org with members cannot be accidentally cascade-deleted; org deletion is a
  deliberate admin workflow)

### 2.2 users.organization_id (CONFIRMED: keep)
Keep users.organization_id as the primary/active organization pointer.
- Preserves current app behavior (getUserOrgContext keeps returning one org).
- memberships is the source of truth for "which orgs may this user access";
  users.organization_id is the "currently active org" shortcut.
- Do NOT retire or rename it in 002. Retiring it is a future gate.

### 2.3 Backfill strategy
For every users row with non-null organization_id, insert one membership:
(user_id = users.id, organization_id = users.organization_id, role = users.role or
'admin' if that user is the org owner). Runs inside the 002 transaction, after table
creation, before RLS enable.
Validation: count(memberships) == count(users where organization_id is not null).

## 3. RLS / session-variable model

### 3.1 Principles
- No auth.uid(); no Supabase Auth dependency.
- Tenant context provided per-transaction via session variables set by lib/data on
  the SAME connection, immediately before tenant-scoped queries:
  - app.current_user_id
  - app.current_organization_id

### 3.2 Helper functions (SECURITY DEFINER, pinned search_path, no auth.* refs)
- app_current_user_id() returns uuid
  -> current_setting('app.current_user_id', true)::uuid   (null if unset)
- app_current_org_id() returns uuid
  -> current_setting('app.current_organization_id', true)::uuid   (null if unset)
- app_is_member(target_org uuid) returns boolean
  -> EXISTS membership for (app_current_user_id(), target_org)
current_setting(..., true) returns null when unset, so missing context -> null -> deny.

### 3.3 Policy keying (CONFIRMED by ChatGPT)
Policies require BOTH:
(a) row.organization_id = app_current_org_id(), AND
(b) app_is_member(row.organization_id) is true.
Current-org match alone is NOT sufficient. Membership is independently required, so a
wrong/forged org on the session is denied unless the authenticated user truly belongs.

## 4. Table policy scope

Enable RLS and add SELECT/INSERT/UPDATE/DELETE policies (with_check mirrors USING on
writes) on every tenant table, all via the helper functions, none referencing auth.*:
- organizations  (visible/writable if id = current org AND member)
- users          (row's organization_id = current org AND member)
- memberships    (row's organization_id = current org AND member)
- scans, vendor_results, evidence_items, scan_feedback, audit_log, watchlist, alerts
  (organization_id = current org AND member)
Onboarding inserts (new org / first membership) are handled by the bootstrap path
(Section 5.4), not normal client policies.

## 5. App-layer enforcement scope

### 5.1 Transaction-bound tenant context (CONFIRMED by ChatGPT)
- Use transaction-bound context: open a transaction, SET LOCAL (or
  set_config(name, value, true)) for app.current_user_id and
  app.current_organization_id, then run tenant-scoped queries in that SAME
  transaction/connection.
- Do NOT use a global pooled SET without reset. The query and its tenant context MUST
  share the same DB connection. SET LOCAL auto-clears at transaction end, preventing
  context leakage across pooled connections.

### 5.2 Chokepoint preserved
All privileged access stays behind lib/data. Existing app-layer org filters REMAIN
(belt-and-suspenders). RLS is added underneath.

### 5.3 Worker tenant context
Worker calls loadScanForProcessing(scanId) -> DB-derived organization_id, then sets
the transaction-local context (org, and the scan-owner user or a dedicated worker
identity) before writes. Worker writes satisfy RLS using DB-derived org, never an
event-payload org.

### 5.4 Controlled onboarding / bootstrap (CONFIRMED by ChatGPT)
New org + new user + first membership cannot satisfy "must already be a member" RLS
(chicken-and-egg). Design:
- A narrowly-scoped SECURITY DEFINER function (or an equivalent privileged
  server-side transaction) performs the bootstrap: create organization, create or
  link the user, and create the first membership - atomically.
- It uses trusted identity from the server auth layer, NOT request-supplied
  organization_id.
- Clients are NOT granted direct ability to create memberships.
- The function is audited (logged) and kept minimal in scope.

### 5.5 Preventing arbitrary org IDs
lib/data sets app.current_organization_id ONLY from trusted ctx.organizationId
(derived from the authenticated user via getUserOrgContext) or from
loadScanForProcessing (DB-derived). No code path sets it from request body/query/params.

### 5.6 Future Entra mapping
When Entra replaces Supabase Auth (later gate), getUserOrgContext's INPUT changes:
the Entra subject resolves to an internal users.id via an identity-link column (e.g.
entra_subject). app.current_user_id then carries that internal users.id. RLS is
unchanged - it already keys off internal ids + memberships, not auth.uid().

## 6. Backward compatibility

- users.organization_id stays as primary/active org; no app code must change.
- memberships is additive; existing flows do not read it yet (RLS helper
  app_is_member equals current behavior for one-membership-per-user).
- No product/UX change in 002. Org-switching, invites, multi-org dashboards deferred.
- Net runtime effect: identical app behavior, plus a database that independently
  denies cross-org access - PROVIDED the app connects as the least-privileged runtime
  role (Section 12).

## 7. Test plan (all pass on a disposable DB before any production apply)

Setup: orgs A and B, each with a user + scans/children; memberships backfilled.
CRITICAL: run the RLS tests as the runtime role cbc_app, NOT as cbcpgadmin (admin/
owner would bypass RLS and produce false PASSes).

Database-layer (RLS) tests:
1. Context (userA, orgA): SELECT scans -> only orgA rows.
2. Context (userA, orgA): UPDATE a orgB scan by id -> 0 rows / denied.
3. Context (userA, orgA): INSERT scan with organization_id = orgB -> denied (with_check).
4. Worker sim: context orgB, INSERT evidence for orgB scan -> allowed; for orgA -> denied.
5. No session variables set -> all tenant SELECT/INSERT/UPDATE/DELETE denied.
6. Wrong org var: app.current_organization_id = orgB but userA not a member of orgB
   -> denied (app_is_member false).
7. Valid membership: context (userA, orgA), userA member of orgA -> allowed.
8. Role-bypass guard: confirm cbc_app does NOT have BYPASSRLS and is NOT a table
   owner; repeat test 1 as cbc_app and confirm RLS applies (only orgA rows). Repeat
   as cbcpgadmin and confirm it bypasses (proves the role distinction is real and why
   the app must use cbc_app).

App-layer tests:
9. With RLS not relied upon (harness), confirm lib/data still filters by org.
10. Regression: no route sets org from client input (re-run A.1 check).

Pass criteria: zero cross-tenant read/write at the DATABASE layer when connected as
cbc_app, AND app-layer enforcement independently holds.

## 8. CISO-buyer explanation (honest, no overclaiming)

- Today: application-layer tenant isolation enforced centrally; org derived from the
  authenticated user, never client input; jobs re-derive org from trusted DB state.
- After 002: database-enforced RLS adds an independent second wall, keyed off app-set
  context plus verified membership, AND the app runs under a least-privileged role so
  RLS genuinely applies. A cross-tenant leak would require BOTH layers to fail.
- Not yet claimed: enterprise SSO and full Entra/runtime/data cutover are SEPARATE
  later gates and are NOT complete at 002. We will not call the product "fully
  Azure-native" or "SSO-enabled" until those gates close.

## 9. Rollout gates (each needs its own approval)

1. 002 design (this v2 document).
2. 002 migration file (memberships + backfill + helpers + RLS + role grants).
3. 002 disposable-DB dry-run (run Section 7 tests, including the cbc_app role tests).
4. 002 app integration (lib/data transaction-bound context; worker context; tests).
5. 002 production apply (apply to cbc_prod; verify; no real app traffic yet).
6. No data migration / cutover until later gates (Entra, runtime, jobs, data) are
   designed and approved.

## 10. Confirmed decisions (from ChatGPT review)

- memberships FK: user_id CASCADE, organization_id RESTRICT. CONFIRMED.
- RLS requires current-org match AND verified membership. CONFIRMED.
- Onboarding via controlled SECURITY DEFINER bootstrap; no direct client membership
  creation; trusted server identity only. CONFIRMED.
- Transaction-bound context via SET LOCAL / set_config(...,true); same connection;
  no global pooled SET. CONFIRMED.
- Keep users.organization_id as primary/active org; do not retire in 002. CONFIRMED.

## 11. Database runtime role design (NEW - required amendment from ChatGPT)

Concern: RLS is bypassed for table owners and BYPASSRLS/superuser roles. If the app
connects as cbcpgadmin (admin/owner), RLS would do nothing and the second wall would
be ineffective. 002 must separate the migration/admin role from the runtime role.

Design:
- cbcpgadmin = migration/admin role ONLY. Owns objects, runs migrations. Never used
  by the running application.
- cbc_app = least-privileged application runtime role:
  - NOT a table owner.
  - Does NOT have BYPASSRLS. Does NOT have SUPERUSER.
  - Granted ONLY the privileges the app needs: SELECT/INSERT/UPDATE/DELETE on the
    specific tenant tables (and only the operations required), plus EXECUTE on the
    helper functions and the bootstrap function.
  - Subject to RLS like any normal role.
- RLS policy validation MUST be performed while connected as cbc_app (Section 7 test
  8). Validating as cbcpgadmin gives false confidence because the admin bypasses RLS.
- The SECURITY DEFINER bootstrap function is owned by a role with the necessary
  insert rights, narrowly scoped to the bootstrap operation, EXECUTE-granted to
  cbc_app, and audited. It is the only sanctioned way cbc_app can create the initial
  org/user/membership.
- Migration responsibilities: the 002 migration (run as cbcpgadmin) creates cbc_app,
  sets its grants, enables RLS, and creates policies/functions. The app's connection
  string (a later runtime gate) must use cbc_app, not cbcpgadmin. Storing/rotating
  the cbc_app credential in Key Vault is a runtime-gate concern, noted here.

Open implementation detail for the migration gate: the exact least-privilege GRANT
set for cbc_app (per-table), and confirming function ownership / search_path so the
SECURITY DEFINER helpers run correctly when called by cbc_app.

## 12. Boundaries honored

Design only. No migration file created. No database change. No app change. No traffic
move. No data import. The 002 migration will be written only after this v2 design is
accepted, and even then applied dry-run-first on a disposable DB, never straight to
cbc_prod.
