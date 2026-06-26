# Gate 003F - SQL Transaction Path Design

## 1. Gate status

Design only. No code is written, no dependency is added, no Azure resource
is touched, and no connection to `cbc_prod` is made by this gate. This
document defines the architecture direction for the future Gate 003E
runtime implementation; it does not implement it.

## 2. Background

Gate 003D Slice 1 created `public.app_record_fast_scan_result(...)`, a
SECURITY DEFINER, boundary-only function that refuses cross-tenant access
and refuses missing session context. It is merged on master at `b00a2b4`.

The Gate 003E plan (merged at `144a165`) defined the runtime call
requirement: the caller must set `app.current_user_id` and
`app.current_organization_id` as transaction-local config and then call
`app_record_fast_scan_result(...)` inside that same transaction, without
ever passing `organization_id` as a function argument.

The Gate 003E discovery note (merged at `0683d5b`) found that the current
Supabase `.from()` helper pattern, built on `createPrivilegedClient()` and
the Supabase service role key, cannot guarantee that a `set_config(...)`
call and a function call share one transaction boundary. That gap is why
this design gate exists.

## 3. Required transaction shape

The future implementation must execute the following as one transaction,
with no other statements interleaved:

```sql
BEGIN;
SELECT set_config('app.current_user_id', '<user-id>', true);
SELECT set_config('app.current_organization_id', '<org-id>', true);
SELECT public.app_record_fast_scan_result(...);
COMMIT;
```

`<user-id>` and `<org-id>` must come from server-verified session state,
never from client-supplied input. `organization_id` must never appear as a
direct function argument to `app_record_fast_scan_result` - it only ever
reaches the function through the second `set_config` call above.

## 4. Architecture decision

CBC's target architecture remains Azure-native. The target database for
this runtime path is Azure Database for PostgreSQL, accessed by a
least-privileged runtime role such as `cbc_app` rather than a superuser or
service-role-equivalent credential.

The approved direction is a server-only direct PostgreSQL transaction path
that can express the exact transaction shape in Section 3. This path must
be validated against a local disposable PostgreSQL database before any
Azure or production use.

The current Supabase service-role `.from()` pattern is legacy/current-state
only. It must not be extended or deepened for this call path, and it is
not the long-term architecture for this or future tenant-boundary-sensitive
calls.

## 5. Options considered

- Direct PostgreSQL client path: a server-only module using a direct
  Postgres driver to run the exact transaction in Section 3 against the
  database, with no PostgREST or Supabase client involved in this call.
  ACCEPTED. This is the only option that can literally guarantee the
  required transaction shape, and it speaks the same protocol regardless of
  whether the database is currently hosted or later moved to Azure Database
  for PostgreSQL.

- Supabase RPC wrapper: a SECURITY DEFINER function that internally calls
  set_config(...) and then app_record_fast_scan_result(...), exposed only
  through Supabase's .rpc(). REJECTED. This ties the design to
  PostgREST-specific request/transaction semantics that do not exist on a
  vanilla Azure Database for PostgreSQL deployment, and it does not move
  away from the Supabase-centric pattern this gate is meant to leave behind.

- Separate Supabase .from() calls composed in sequence, relying on a pooled
  connection to preserve GUC state between them. REJECTED. This is the
  exact unsafe pattern the Gate 003E discovery note already identified -
  no guaranteed shared transaction, and a real risk of GUC state leaking
  across tenants on a reused pooled connection.

- Passing organization_id as a direct function argument instead of through
  set_config. REJECTED. This directly contradicts the hard rule already
  enforced by Gate 003D (validation check T05) and the explicit security
  requirement that organization_id never appears as a function argument.

- Dedicated long-running microservice holding its own connection pool,
  called internally by the route handler. DEFERRED. Not rejected outright,
  but not needed unless the direct-client path proves insufficient for
  connection-lifecycle or serverless-runtime reasons. Naming it now as a
  possible later answer, not a Gate 003F deliverable.

## 6. Approved direction

The approved direction is a server-only direct PostgreSQL transaction path,
designed for Azure Database for PostgreSQL and a least-privileged runtime
role such as `cbc_app`.

The current local or current-hosted PostgreSQL database may be used only as
a temporary validation bridge during development, and only if explicitly
approved later - not as a substitute for the Azure target, and not as a
permanent arrangement.

No production or Azure use happens in this gate. This document selects a
direction; it does not select a dependency, write any code, or touch any
real database.

## 7. Runtime requirements

- The transaction in Section 3 must run in a Node.js-compatible runtime,
  not an Edge runtime, if implemented with a normal PostgreSQL TCP client.
  Edge runtimes commonly cannot hold a raw TCP database connection.
- The future implementation must confirm, and add if missing, an explicit
  `runtime = "nodejs"` directive wherever this transaction path is invoked,
  rather than assuming the surrounding route's current runtime setting.
- A single transaction helper must own BEGIN, COMMIT, and ROLLBACK
  internally. No caller should manually compose BEGIN/COMMIT around calls
  into this helper.
- No caller should be able to call set_config(...) or
  app_record_fast_scan_result(...) directly without going through this
  helper.

## 8. Security requirements

- `organization_id` must never be passed as a function argument to
  `app_record_fast_scan_result`.
- The database function remains the final tenant-boundary authority. Any
  app-side tenant or membership checks are defense-in-depth only and must
  never be used to skip or short-circuit the database call.
- The runtime must use a least-privileged database role, such as
  `cbc_app`, for this call path - not a superuser role and not the Supabase
  service role.
- `SUPABASE_SERVICE_ROLE_KEY` must not be used for this future path.
- Any connection credential or secret used by this path must be server-only
  and must never be bundled into client-side code.

## 9. Risks / blockers

- Confirm whether `app/api/scan/route.ts` (or wherever this path is
  eventually invoked) runs on Node.js or Edge today, before any driver is
  selected.
- Driver selection itself is not made by this document and must happen as
  a separate, explicit decision.
- Confirm connection pooling behavior with whatever driver is eventually
  chosen, to verify `set_config(..., true)` is correctly scoped per logical
  transaction and not bled across reused connections.
- Confirm whether the `cbc_app` role actually exists, with the correct
  EXECUTE grant, in any real non-disposable environment today. Not
  confirmed by any prior gate document.
- Decide where the runtime connection credential/secret will live per
  environment. This is a separate decision from, and does not depend on
  resolving, the still-open `cbcpgadmin` / Key Vault credential mismatch.
- Define the local disposable-PostgreSQL validation approach for the
  eventual transaction module itself (exercising the actual module code,
  not just raw psql), mirroring the approach already used for Gate 003D.
- Confirm that Gate 003D Slice 2 (future write behavior) will not change
  `app_record_fast_scan_result`'s interface in a way that invalidates the
  wrapper shape designed here.
- The `cbcpgadmin` / Key Vault credential mismatch remains a separate,
  unresolved, out-of-scope item and must not be conflated with this design.

## 10. Out of scope

- No package dependency is added by this gate.
- No runtime code is written by this gate.
- No changes to `app/api/scan/route.ts` or any other route.
- No database migrations.
- No Azure infrastructure provisioning or configuration.
- No connection to `cbc_prod`.
- No Key Vault changes.
- No deploy.

## 11. Smallest future implementation PR

When implementation begins, as a separate, later, explicitly approved PR:

- Add the approved dependency only after founder approval of the specific
  package.
- Add a single server-only transaction module implementing the helper
  described in Section 7.
- Add local disposable-PostgreSQL validation for that module's actual code.
- Do not wire the module into `app/api/scan/route.ts` or any other route
  until the module itself is proven against local validation.

## 12. Decision required before implementation

- Founder approval of the specific dependency and the transaction design
  described in this document.
- ChatGPT architecture and security review of this document.
- Explicit approval recorded before any implementation code PR is opened.
