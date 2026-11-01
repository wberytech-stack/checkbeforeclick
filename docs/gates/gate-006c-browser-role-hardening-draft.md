# Gate006C → Gate007A: draft browser-role privilege remediation

**Status: draft only; no real database migration authorized.** This is a new
Supabase migration proposal, not an update to the Azure PostgreSQL migrations.
The existing Gate007A identity trigger (migration 002) remains a separate
prerequisite. Do not merge, deploy, bootstrap, create accounts, or run a live
authenticated journey on the strength of this document.

## Read-only staging evidence (2026-11-01 UTC)

Verified the active Supabase staging project `zgxmvpbvvakpsnzcymsf` by project
metadata. Queried only `pg_class`, `pg_namespace`, `pg_policies`, `pg_proc`,
`pg_attribute` and privilege metadata; no application data or credentials.

- Ten existing `public` tables have explicit full table privileges granted
  to **both** `anon` and `authenticated`, including `TRUNCATE`. Two new
  Gate007A ledger tables have no browser-role grants. RLS is enabled on all
  twelve tables, but PostgreSQL `TRUNCATE` bypasses RLS. This is an excessive
  grant; ordinary PostgREST table routes do not expose arbitrary TRUNCATE.
- `organizations` and `scans` have own-org UPDATE policies with broad UPDATE
  grants. A signed-in user may be able to change plan/counters, scan verdicts,
  and other server-owned fields within RLS-eligible rows. This is **not** proof
  of cross-tenant access or an executed exploit.
- `scans` also has an own-org INSERT policy and browser INSERT privileges.
  Direct data-API inserts could bypass the intended Gate007A
  `cbc_admit_scan` admission path. No such insert was attempted.
- **New finding (2026-11-01 UTC):** `evidence_items` and
  `vendor_results` have own-org INSERT policies plus direct browser INSERT
  grants. `lib/data/index.ts` writes these tables through the privileged
  server-only data chokepoint; no browser write path was identified there.
  An authenticated member could potentially insert fabricated provider
  findings/evidence for a scan in their own organization, undermining scan
  integrity even if `scans` writes are closed. No insert or exploit was run.
- **New finding:** `scan_cache` has no tenant identifier, and its live
  `cache_select_authenticated`, `cache_insert_authenticated`, and
  `cache_update_authenticated` policies use only
  `auth.uid() IS NOT NULL`. With the observed table grants, a signed-in
  client can potentially read and poison shared cached results across
  tenants. The repository's current app data chokepoint does not expose a
  browser cache feature; no exploit or cache-data read was attempted.
- The live `handle_new_user` and `get_user_org_id` functions are
  SECURITY DEFINER, owned by `postgres`; the two Gate007A admission/provider
  RPCs are also SECURITY DEFINER and executable by `authenticated`.

## Proposed change

`infra/supabase/migrations/003_browser_role_privilege_hardening.sql`:

1. Remove TRUNCATE from both browser roles on existing public tables.
2. Remove browser INSERT/UPDATE/DELETE on `organizations` and `scans`.
3. Remove browser INSERT/UPDATE/DELETE on `evidence_items` and
   `vendor_results`, preserving their RLS-scoped SELECT access. These are
   server-generated scan findings, not browser-submitted feedback.
4. Remove browser INSERT/UPDATE/DELETE on `users`, then allow
   `authenticated` to UPDATE **only** `full_name` (under the existing
   own-profile RLS policy).
5. Remove all browser table privileges on the global `scan_cache`.

No service-role grants, RLS policies, functions, triggers, secrets or data are
modified. This does not make the service-role path safer by itself; it closes
the direct browser data-API path. The migration intentionally does not address
all remaining table grants (e.g. `audit_log` has an own-org INSERT
policy, while `watchlist` has legitimate browser write policies); those need
a separate app-contract and authorization audit.
New tables may receive default grants and need their own review.

## Verification actually performed

The exact read-only SQL in
`infra/supabase/validation/003_browser_role_privilege_checks.sql`
was executed against **staging before any remediation**, on 2026-11-01 UTC:

| Check | Baseline |
| --- | --- |
| required_tables_exist | PASS |
| authenticated_scan_rpcs_preserved | PASS |
| service_role_data_writes_preserved | PASS |
| no_browser_scan_or_org_writes | BLOCK |
| no_browser_evidence_or_vendor_writes | BLOCK |
| no_browser_truncate_on_any_public_table | BLOCK |
| no_browser_users_identity_or_row_writes | BLOCK |
| authenticated_profile_name_edit_preserved | BLOCK |
| shared_scan_cache_closed_to_browser_roles | BLOCK |

These six BLOCKs are the expected **pre-migration baseline** across nine
read-only checks (three PASS), not evidence the draft migration works.
The updated SQL was executed against staging and returned these nine rows.
It now also detects effective column-level INSERT/UPDATE privileges on
server-owned tables and column-level access to the shared cache. The SQL was not applied to staging, production or any
other database. No local Docker/disposable-DB test or role-scoped DML test ran.

## Required disposable-database validation before approval

On a disposable local Supabase-compatible Postgres (not a live database):

1. Reproduce the existing schema, grants, RLS, Auth roles/functions, Gate007A
   migration 001, and migration 002. Run the read-only checks and capture
   baseline failures.
2. Apply **only the draft 003** on the disposable database, then rerun
   `003_browser_role_privilege_checks.sql`. Require all eight PASS.
3. Negative controls as `anon` and `authenticated`: reject direct
   scan INSERT/UPDATE/DELETE; organization plan/counter UPDATE; direct
   evidence_items/vendor_results INSERT/UPDATE/DELETE; users tenant/role
   UPDATE and INSERT/DELETE; scan_cache SELECT/INSERT/UPDATE;
   TRUNCATE on every existing public table. Verify denial by privileges,
   not merely RLS or missing sample rows.
4. Positive controls: authenticated user can edit only their own
   `full_name`; cannot edit another user's profile; sign-up via
   `auth.users` trigger still creates an organization/user; service-role
   can create/finish a scan, insert evidence/vendor results and update
   the organization; authenticated
   `cbc_admit_scan` and `cbc_reserve_provider_call` remain callable.
5. Reapply 003 on the disposable database to verify idempotence; test
   transaction rollback on an injected failure; inspect function execution
   contexts, RLS and tenant isolation. Do not use paid providers.
6. Independently review the diff and evidence, then obtain a **separate,
   explicit founder decision** for any staging-only migration apply. A
   staging PASS is not a production approval or an authenticated security
   sign-off.

Related: draft preflight PR #56 and Gate007A integration PR #55. Both
remain unmerged. Do not modify their branches from this gate.
