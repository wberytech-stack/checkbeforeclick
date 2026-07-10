# Gate 003I - Runtime Scan Write Integration Plan

## 1. Gate purpose

This gate is a design-only gate for wiring the server-only PostgreSQL
transaction helper into the runtime scan result write path in a future
implementation gate.

No runtime code is changed by this gate.

The purpose is to define the safe transaction flow that will eventually
replace the current scan-result write path with the direct SQL transaction
path established by Gates 003F, 003G, and 003H.

## 2. Current state

Gate 003G added `src/server/db/postgres.ts`, which exports
`withPgTransaction<T>(callback)`. The helper imports `server-only`, uses
`pg`, caches the PostgreSQL pool on `globalThis.__cbcPgPool`, starts a
transaction with `BEGIN`, commits on success, rolls back on error, and
always releases the client.

Gate 003H validated the actual helper against disposable local
PostgreSQL. It proved successful transactions commit, thrown errors roll
back, and transaction-local `set_config(..., true)` values are readable
through `current_setting(...)` on the same client inside the same
transaction.

## 3. Future implementation files expected to change

The future implementation gate is expected to touch only a narrow set of
runtime files, likely:

- `app/api/scan/route.ts`
- possibly a small server-only adapter under `src/server/scan/` or
  `src/server/db/`

The exact file list must be approved in the implementation gate before
code is written.

## 4. Files forbidden in this design gate

This design gate must not modify:

- `app/api/scan/route.ts`
- `src/server/db/postgres.ts`
- `package.json`
- `package-lock.json`
- migrations
- Azure configuration
- Key Vault configuration
- deployment configuration
- Supabase auth or client setup

## 5. Proposed transaction flow

The future runtime scan write path should:

1. Authenticate the request on the server.
2. Resolve the authenticated application user ID on the server.
3. Resolve the authenticated organization ID on the server.
4. Perform any app-side checks as defense-in-depth.
5. Open one PostgreSQL transaction using `withPgTransaction`.
6. Set transaction-local identity GUCs.
7. Call `public.app_record_fast_scan_result(...)`.
8. Return the database function result.
9. Roll back the entire transaction if any step fails.

## 6. Required server-side identity source

The user ID and organization ID must come only from authenticated
server-side context.

They must not come from client-supplied JSON, query parameters, headers
controlled by the browser, hidden form fields, URL parameters, or any
user-editable value.

The app may perform server-side membership checks before calling the
database function, but those checks are defense-in-depth only. The
database function remains the final tenant-boundary authority.

## 7. Required SQL sequence

Inside one `withPgTransaction` callback, using the same `client` instance:

```ts
await client.query(
  "SELECT set_config('app.current_user_id', $1, true)",
  [userId]
);

await client.query(
  "SELECT set_config('app.current_organization_id', $1, true)",
  [organizationId]
);

const result = await client.query(
  "SELECT public.app_record_fast_scan_result(/* approved args only */) AS scan_id",
  [
    // approved non-tenant business arguments only
  ]
);
```

The required SQL order is:

```sql
SELECT set_config('app.current_user_id', $1, true);
SELECT set_config('app.current_organization_id', $1, true);
SELECT public.app_record_fast_scan_result(...);
```

Both `set_config` calls must use `true` so the settings are scoped to the
current transaction. The function call must happen only after both
transaction-local identity settings are established.

## 8. Organization ID must not be passed to the DB function

`organization_id` must not be passed as an argument to
`public.app_record_fast_scan_result(...)`.

The only approved way for organization identity to reach the function is
through transaction-local database context:

1. Resolve `organizationId` from authenticated server-side context.
2. Set `app.current_organization_id` with
   `SELECT set_config('app.current_organization_id', $1, true)`.
3. Let `public.app_record_fast_scan_result(...)` read and enforce tenant
   identity from database context.

This rule remains mandatory even if the route has already performed
server-side membership checks.

## 9. Rollback and error behavior

`withPgTransaction` remains responsible for `BEGIN`, `COMMIT`, `ROLLBACK`,
and client release.

Expected future behavior:

- If identity resolution fails before the transaction begins, no scan
  result write is attempted.
- If either `set_config` call fails, the helper rolls back and the
  database function is not treated as successful.
- If `public.app_record_fast_scan_result(...)` throws a database error,
  the helper rolls back the whole transaction.
- If all statements succeed, the helper commits once.
- Transaction-local GUC values must end with the transaction and must not
  leak across pooled client reuse.
- Route-level error handling may convert failures into HTTP responses,
  but it must not retry with client-trusted tenant input or bypass the
  database function.

## 10. Future testing plan

The future implementation gate should test the runtime write path without
using Azure, `cbc_prod`, Key Vault, deploy, or migrations.

Required coverage:

- The scan write path uses `withPgTransaction`.
- `set_config('app.current_user_id', $1, true)` runs before the function
  call.
- `set_config('app.current_organization_id', $1, true)` runs before the
  function call.
- `public.app_record_fast_scan_result(...)` runs inside the same
  transaction callback.
- `organization_id` is absent from the database function argument list.
- `userId` comes from authenticated server-side context only.
- `organizationId` comes from authenticated server-side context only.
- Client-trusted tenant input is rejected or ignored.
- Database function errors roll back the transaction.
- Missing transaction-local identity does not produce a successful write.
- `SUPABASE_SERVICE_ROLE_KEY` is not used for this path.

Where practical, validation should use disposable local PostgreSQL in the
same spirit as Gate 003H.

## 11. Manual validation plan

Manual validation for the future implementation should use only approved
local or disposable resources unless a later gate explicitly authorizes a
different environment.

Validate that:

- A request with authenticated server-side user and organization context
  can write one scan result.
- The written result is bound to the organization enforced by database
  session context.
- A request without authenticated user context fails.
- A request without authenticated organization context fails.
- A request with forged client tenant input cannot cause a cross-tenant
  write.
- A deliberate database function failure rolls back the transaction.
- No Azure, `cbc_prod`, Key Vault, deploy, migration, or production
  resource is touched.

## 12. Security review checklist

Reviewers must confirm:

- `organization_id` is not passed to
  `public.app_record_fast_scan_result(...)`.
- `userId` comes from authenticated server-side context only.
- `organizationId` comes from authenticated server-side context only.
- No client-trusted tenant input influences tenant context.
- The database function remains the final tenant-boundary authority.
- App-side checks are defense-in-depth only.
- `SUPABASE_SERVICE_ROLE_KEY` is not used for this future path.
- The SQL sequence runs inside one `withPgTransaction` callback.
- Both `set_config` calls use transaction-local scope with `true`.
- The future route path runs in a Node.js-compatible server runtime.
- Errors roll back the transaction.
- Transaction-local identity cannot leak across pooled client reuse.
- The implementation gate does not bundle Azure, `cbc_prod`, Key Vault,
  deploy, or migration work.

## 13. Rollback plan

Rollback for this design gate is deleting this document.

Rollback for the future implementation gate should be a normal code revert
of the route wiring, any server-only adapter, and related tests or
validation artifacts. Because this plan does not require a migration or a
database function signature change, the future implementation should be
reversible without database rollback work if it stays within scope.

If validation finds a tenant-boundary, identity-source, or transaction
ordering issue, the implementation must be reverted or disabled. It must
not fall back to passing `organization_id` as a function argument, using
client-trusted tenant input, or using `SUPABASE_SERVICE_ROLE_KEY`.

## 14. Non-goals

This gate does not:

- Modify `app/api/scan/route.ts`.
- Modify `src/server/db/postgres.ts`.
- Modify `package.json`, `package-lock.json`, or `tsconfig.json`.
- Modify migrations.
- Create runtime implementation code.
- Call `public.app_record_fast_scan_result(...)`.
- Change route behavior.
- Change authentication behavior.
- Use `SUPABASE_SERVICE_ROLE_KEY` for this future path.
- Trust client-supplied tenant input.
- Touch Azure, `cbc_prod`, Key Vault, or deploy.

## 15. Acceptance criteria for this design gate

This design gate is accepted when:

- `docs/gates/gate-003i-runtime-scan-write-integration-plan.md` includes
  sections 1 through 15.
- The TypeScript code block in section 7 is closed.
- The required SQL sequence is documented:
  `SELECT set_config('app.current_user_id', $1, true)`,
  `SELECT set_config('app.current_organization_id', $1, true)`, and
  `SELECT public.app_record_fast_scan_result(...)`.
- The document explicitly states that `organization_id` must not be
  passed to the database function.
- The document requires `userId` and `organizationId` to come from
  authenticated server-side context only.
- The document states that the database function remains the final
  tenant-boundary authority.
- The document states that app-side checks are defense-in-depth only.
- The document forbids `SUPABASE_SERVICE_ROLE_KEY` for this future path.
- The document forbids client-trusted tenant input.
- The document includes rollback/error behavior, future testing, manual
  validation, a security review checklist, rollback plan, and non-goals.
- No forbidden file is modified.
- No runtime behavior changes are made.
