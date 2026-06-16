# Gate 002 - Tenant Isolation Design

> DESIGN ONLY. No migration file, no database change, no app change, no traffic
> move, no data import. This document is for review before any 002 SQL is written.
> Branch: audit/azure-current-state. Builds on Phase A.1 audit (commit 5a6d5af).
> No secrets in this document.

## 0. Context

Phase A.1 verified the app already enforces tenant isolation at the application
layer: a single privileged DB chokepoint (lib/data), every read/update org-scoped,
inserts stamp organization_id server-side, no route trusts client-provided org, org
context derived from the authenticated user, and the worker re-derives org from DB
state. cbc_prod already holds the 001 baseline schema (10 tables, no RLS, no
memberships). 002 ADDS a second, database-enforced wall; it does not repair the app
layer.

## 1. Final purpose of 002

- Introduce a memberships table (user-to-organization relationship + role).
- Preserve current one-org-per-user behavior initially (no UX change).
- Prepare for future multi-org / MSP capability without another tenant-model migration.
- Add database-level tenant isolation (RLS) as an independent second wall, keyed off
  app-set session variables - NOT auth.uid(), NOT Supabase Auth.

## 2. Proposed schema changes

### 2.1 memberships table
Columns:
- id            uuid primary key default gen_random_uuid()
- user_id       uuid not null  -> references users(id)
- organization_id uuid not null -> references organizations(id)
- role          text not null default 'member'
- created_at    timestamptz not null default now()
- updated_at    timestamptz not null default now()

Constraints / indexes:
- UNIQUE (user_id, organization_id)  -- a user has at most one membership row per org
- CHECK (role IN ('owner','admin','member','viewer'))  -- forward-compatible role set
- index on (user_id)              -- fast "which orgs does this user belong to"
- index on (organization_id)      -- fast "who belongs to this org"
- FKs: ON DELETE CASCADE from both parents is NOT chosen automatically; see note.

FK delete behavior: recommend ON DELETE CASCADE on user_id (if a user is deleted,
their memberships go) and ON DELETE RESTRICT on organization_id (do not allow
deleting an org that still has members, to avoid orphaning). To be finalized in the
migration; documented here as a decision point.

Role model: introduce the full set ('owner','admin','member','viewer') in the CHECK
now (cheap, forward-compatible), but the app only USES 'admin'/'member' for MVP.
This avoids a later constraint change.

### 2.2 users.organization_id - keep as primary-org compatibility
Decision: KEEP users.organization_id for now as the "primary org" pointer.
Reasoning:
- The entire app currently reads org via getUserOrgContext, which selects
  users.organization_id. Removing it now would force app changes that are out of
  scope for 002 (which is meant to be backend defense-in-depth, no UX change).
- Treat users.organization_id as the user's PRIMARY/active org for MVP.
- memberships becomes the source of truth for "what orgs may this user access";
  users.organization_id is the "currently active org" shortcut.
- A later gate can migrate the app to resolve active org purely from memberships and
  retire users.organization_id. Documented as future work, not 002.

### 2.3 Backfill strategy
For every existing users row with a non-null organization_id, insert one membership
row: (user_id = users.id, organization_id = users.organization_id, role = users.role
or 'admin' if that user is the org's first/owner). This preserves exactly today's
one-org-per-user reality as one membership each. Backfill runs inside the 002
migration transaction, after the table is created, before RLS is enabled.

Backfill validation: count(memberships) must equal count(users where
organization_id is not null) after backfill.

## 3. RLS / session-variable model

### 3.1 Principles
- Do NOT use auth.uid(). Do NOT depend on Supabase Auth.
- Tenant context is provided per-connection via session variables set by the app
  (lib/data) immediately before queries run on the privileged connection:
  - app.current_user_id          (uuid of the authenticated internal user)
  - app.current_organization_id  (uuid of the active org from trusted context)
- RLS reads those variables via helper functions.

### 3.2 Helper functions (SECURITY DEFINER, pinned search_path, no auth.* refs)
- app_current_user_id() returns uuid
  -> returns current_setting('app.current_user_id', true)::uuid (null if unset)
- app_current_org_id() returns uuid
  -> returns current_setting('app.current_organization_id', true)::uuid (null if unset)
- app_is_member(target_org uuid) returns boolean
  -> true if a memberships row exists for (app_current_user_id(), target_org)

Note: current_setting(..., true) returns null instead of erroring when the variable
is missing - so "missing session variable" cleanly yields null -> deny.

### 3.3 Policy keying decision
Decision: policies require BOTH (a) the row's organization_id equals
app_current_org_id() AND (b) the current user is a member of that org
(app_is_member). 
Reasoning: keying only on current org would trust whatever org the connection set.
Also requiring membership means that even if a wrong/forged org were ever set on the
session, access is denied unless the authenticated user truly belongs to it. This is
the database-level equivalent of "org derived from authenticated user, not input."
For MVP (one membership per user) this is equivalent to today's behavior, but it is
robust to the future multi-org world.

## 4. Table policy scope

Enable RLS and add policies on all tenant tables. Pattern per table:

- organizations: a row is visible/updatable if its id = app_current_org_id() AND
  app_is_member(id). Insert of a new org is a privileged/onboarding path (see 5.4).
- users: a row is visible if users.organization_id = app_current_org_id() AND
  app_is_member(users.organization_id). (Self-row access also covered since the
  user's own org is their current org.)
- memberships: a row is visible if organization_id = app_current_org_id() AND
  app_is_member(organization_id). Membership creation is a privileged/onboarding
  path.
- scans, vendor_results, evidence_items, scan_feedback, audit_log, watchlist,
  alerts: each has organization_id; policy = organization_id = app_current_org_id()
  AND app_is_member(organization_id), applied to SELECT/INSERT/UPDATE/DELETE
  (with_check mirrors using on writes so a row cannot be written into another org).

All policies use the helper functions; none reference auth.* or Supabase roles.

## 5. App-layer enforcement scope

### 5.1 Setting tenant context
lib/data sets the session variables on the privileged connection before queries:
- SET app.current_user_id and app.current_organization_id from the trusted
  ctx (ctx.userId, ctx.organizationId from getUserOrgContext), using set_config
  per transaction/connection.
- Because each lib/data function already creates a privileged client, the design
  must ensure the SET happens on the SAME connection that runs the query (use a
  transaction or a connection-scoped set_config). This is the main implementation
  detail to get right in the migration/integration gate.

### 5.2 Chokepoint preserved
All privileged access stays behind lib/data (Phase A.1 confirmed this). RLS is added
underneath; the existing org filters in lib/data REMAIN (belt-and-suspenders).

### 5.3 Worker tenant context
The worker calls loadScanForProcessing(scanId) -> gets the DB-derived
organization_id, then sets app.current_organization_id (and the scan's owner as
current_user, or a dedicated worker context) before any writes. Worker writes thus
satisfy RLS using DB-derived org, never an event-payload org.

### 5.4 Privileged onboarding paths
Signup/org-creation and membership-creation cannot satisfy "must already be a
member" RLS (chicken-and-egg). Design: these run through explicit, narrowly-scoped
privileged operations in lib/data that either (a) run as the table owner / a role
that bypasses RLS for just those inserts, or (b) set context appropriately for the
new row. Documented as a specific implementation concern for the migration gate.

### 5.5 Preventing arbitrary org IDs
Callers never pass org to set_config directly from input; lib/data sets it only from
ctx.organizationId (derived from the authenticated user via getUserOrgContext) or
from loadScanForProcessing (DB-derived). No code path sets app.current_organization_id
from request body/query/params.

### 5.6 Future Entra mapping
When Entra replaces Supabase Auth (later gate), getUserOrgContext's INPUT changes:
the Entra subject is resolved to an internal users.id (via an identity-link column,
e.g. entra_subject). app.current_user_id then carries that internal users.id. The RLS
model is unchanged - it already keys off internal ids + memberships, not auth.uid().

## 6. Backward compatibility

- users.organization_id remains as the primary/active-org pointer; no app code must
  change to keep working (getUserOrgContext keeps returning a single org).
- memberships is additive; existing flows do not read it yet (except the new RLS
  helper app_is_member, which for one-membership-per-user equals current behavior).
- No product/UX change in 002. Org-switching, invites, multi-org dashboards are
  deferred to a later, explicitly-approved gate.
- Net effect of 002 at runtime: identical app behavior, plus a database that will now
  independently deny cross-org access.

## 7. Test plan (must all pass on a disposable DB before any production apply)

Setup: two orgs A and B, each with a user and scans/children; memberships backfilled.

Database-layer (RLS) tests, run by setting session variables directly:
1. Set context to (userA, orgA): SELECT scans -> only orgA rows. PASS if no orgB rows.
2. Set context to (userA, orgA): attempt UPDATE a orgB scan by id -> 0 rows / denied.
3. Set context to (userA, orgA): attempt INSERT a scan with organization_id = orgB
   -> denied by with_check.
4. Worker simulation: set context to orgB (as loadScanForProcessing would), INSERT
   evidence for a orgB scan -> allowed; attempt same against orgA -> denied.
5. No session variables set -> all tenant-table SELECT/INSERT/UPDATE denied (helpers
   return null -> policies false).
6. Wrong org variable: set app.current_organization_id = orgB but user is userA who
   is NOT a member of orgB -> denied (app_is_member false).
7. Valid membership: userA member of orgA, context (userA, orgA) -> allowed.

App-layer tests (independent of RLS):
8. With RLS temporarily not relied upon (test harness), confirm lib/data still filters
   by org (existing behavior) - proving two independent layers.
9. Regression: confirm no route sets org from client input (re-run the A.1 check).

Pass criteria: zero cross-tenant read or write at the DATABASE layer AND the app
layer continues to enforce independently.

## 8. CISO-buyer explanation (honest, no overclaiming)

- Today: tenant isolation is enforced at the application layer through a single
  centralized, server-only data chokepoint; the organization is derived from the
  authenticated user, never from client input; background jobs re-derive the
  organization from trusted database state.
- After 002: the database independently enforces tenant isolation via Row-Level
  Security keyed off app-set session context plus verified membership - a second,
  independent wall. A cross-tenant leak would require BOTH layers to fail.
- Not yet claimed (honest scope): enterprise SSO, full Entra identity cutover, and
  the move off Supabase/Vercel are SEPARATE later gates and are NOT complete at 002.
  We will not describe the product as "fully Azure-native" or "SSO-enabled" until
  those gates close.

## 9. Rollout gates (sequence; each needs its own approval)

1. 002 design (this document).
2. 002 migration file (memberships + backfill + helpers + RLS policies).
3. 002 disposable-DB dry-run (apply to a throwaway DB; run the Section 7 DB tests).
4. 002 app integration (lib/data sets session vars; worker sets context; run app-layer
   + cross-tenant tests against a non-prod DB).
5. 002 production apply (apply migration to cbc_prod; verify; cbc_prod has no real app
   traffic yet so this remains low-risk).
6. No data migration / cutover until all above pass and later gates (Entra, runtime,
   jobs, data) are designed and approved.

## 10. Open decision points for ChatGPT review

- FK delete behavior on memberships (CASCADE on user vs RESTRICT on org) - proposed
  above; confirm.
- Whether RLS policies should require membership in addition to current-org match -
  proposed YES; confirm.
- How onboarding/signup inserts (new org, first membership) bypass the
  chicken-and-egg RLS - needs a chosen mechanism in the migration gate.
- Connection/transaction strategy for set_config so the SET and the query share a
  connection - implementation detail for the integration gate.
- Confirm users.organization_id stays as primary-org for now (proposed YES).

## 11. Boundaries honored

Design only. No migration file created. No database change. No app change. No traffic
move. No data import. The actual 002 migration will not be written until this design
is reviewed and approved.
