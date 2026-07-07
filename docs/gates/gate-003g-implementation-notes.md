# Gate 003G - Implementation Notes

## 1. What this gate adds

This gate adds only the PostgreSQL transaction helper foundation selected
in Gate 003G (PostgreSQL client selection). It does not integrate runtime
scan writes, does not call the Gate 003D database function, and does not
wire anything into the scan route.

## 2. Files added

- `src/server/db/postgres.ts`: server-only PostgreSQL transaction helper.
- `docs/gates/gate-003g-implementation-notes.md`: this note.

## 3. Dependencies added

- `pg`: direct PostgreSQL client for Node.js.
- `@types/pg`: TypeScript type definitions for pg.
- `server-only`: Next.js package that throws a build error if this
  module is imported in a client component. The helper is also not
  suitable for Edge runtime because it uses Node.js PostgreSQL APIs.

## 4. Helper design

The helper exports one function: `withPgTransaction<T>(callback)`.

It acquires one client from a globalThis-cached singleton pool, issues
BEGIN, calls the callback with that client, issues COMMIT on success,
and issues ROLLBACK on any error. The client is always released back to
the pool in a finally block.

The file begins with `import "server-only"` as a real import, not just
a comment. This causes Next.js to throw a build error if the module is
accidentally imported in a client component. The helper must run in the
Node.js server runtime, not Edge runtime, because pg uses Node.js
networking APIs.

The Pool is cached on `globalThis.__cbcPgPool` rather than as a plain
module-level variable. This prevents extra pools from being created
during Next.js server or dev reload behavior, where module-level
variables may be re-initialized but globalThis persists.

All statements inside the callback share one physical connection and one
transaction. This is the requirement established in Gate 003F: the
transaction-local set_config calls and the function call must share one
connection and one transaction boundary.

## 5. Environment variable

The helper reads `CBC_DATABASE_URL` for the connection string. It throws
a clear error at startup if the variable is missing. The connection
string must never be hard-coded or committed.

SSL behavior is controlled by `CBC_DATABASE_SSL`. If set to "false", SSL
is disabled (for local disposable-DB validation). Otherwise SSL is
enabled, which is required for Azure Database for PostgreSQL.

## 6. What this gate does not do

- It does not call `public.app_record_fast_scan_result(...)`.
- It does not set transaction-local app.current_user_id or
  app.current_organization_id GUCs. That is the next gate's job.
- It does not modify `app/api/scan/route.ts`.
- It does not remove or replace Supabase.
- It does not touch Azure, cbc_prod, Key Vault, or deploy.
- It does not pass organization_id as a function argument.
- It does not broaden tenant trust to the client.

## 7. Future gate

The next gate will use this helper to issue transaction-local set_config
calls and then call `public.app_record_fast_scan_result(...)` inside the
same transaction, using the same client instance passed to the callback.
That is the Gate 003F direct SQL transaction path made concrete.

## 8. Local validation

Local disposable-PostgreSQL validation of the helper itself (not just raw
psql) is planned as a follow-on step before any route wiring. The
validation will exercise the actual withPgTransaction function against a
disposable local PostgreSQL database, covering positive, negative, and
concurrency cases per the plan in Gate 003G section 10.

