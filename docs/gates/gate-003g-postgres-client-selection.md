# Gate 003G - PostgreSQL Client Selection

## 1. Gate status

Design only. This gate selects a dependency direction and a local
validation plan; it does not add the dependency, write implementation code,
touch Azure, touch `cbc_prod`, or touch Key Vault.

## 2. Background

Gate 003D Slice 1 created `public.app_record_fast_scan_result(...)`, merged
on master at `b00a2b4`. Gate 003E found that the current Supabase `.from()`
helper pattern cannot guarantee that a transaction-local `set_config(...)`
call and a function call share one transaction boundary (discovery note,
merged at `0683d5b`). Gate 003F approved a direct server-only PostgreSQL
transaction path as the architecture direction (design doc, merged at
`168559a`).

## 3. Required transaction requirement

The future implementation must run the following as one transaction, on
one physical connection, with no other statements interleaved:

- Transaction-local `set_config('app.current_user_id', ..., true)`.
- Transaction-local `set_config('app.current_organization_id', ..., true)`.
- The call to `public.app_record_fast_scan_result(...)`, executed after
  both context values are set, on that same connection, in that same
  transaction.

`organization_id` must never be passed as a direct function argument - it
only ever reaches the function through the `set_config` call above.

## 4. Dependency options considered

- `pg` (node-postgres)
- `postgres.js`
- Kysely
- Drizzle
- Prisma

## 5. Recommended choice: pg

`pg` is recommended for this narrow, security-critical helper because:

- It gives direct transaction control - explicit `BEGIN`, `COMMIT`, and
  `ROLLBACK` issued by the helper itself, with nothing else interpreting or
  rewriting the statements.
- It exposes an explicit `Pool` and `Client` model, which makes it possible
  to guarantee that the `set_config` calls and the function call run on one
  physical connection, in one transaction.
- It is mature and boring - the most widely used, longest-lived Postgres
  driver in the Node ecosystem, which matters for a dependency sitting next
  to a tenant-isolation boundary.
- It is fully compatible with Azure Database for PostgreSQL - same wire
  protocol, same connection model, only the connection string changes.
- It is a good fit for a Node runtime in Azure Container Apps, where a
  pool can be created once at process startup and reused across requests.
- It adds no unnecessary ORM or query-builder abstraction between the
  helper and the exact five-statement transaction it needs to run.
- A narrow, security-critical helper benefits from raw SQL clarity - every
  statement the helper sends to the database is visible and intentional,
  with no abstraction layer deciding how to translate a higher-level call
  into SQL.

## 6. Acceptable fallback: postgres.js

`postgres.js` is technically viable for this same purpose. It is modern and
ergonomic, with good TypeScript support. It was not selected because `pg`
is more conservative and more widely understood for a security-boundary-
adjacent path like this one. If `pg` turns out to be unsuitable for a
reason not yet identified, `postgres.js` is the next option to evaluate
before considering a query builder or ORM.

## 7. Rejected options

- Kysely: a query builder, which adds dependency and abstraction overhead
  that this fixed, five-statement raw transaction does not need.
- Drizzle: a larger architectural commitment than this helper requires,
  including schema and migration assumptions that do not fit a single
  narrow transaction helper.
- Prisma: too heavy for this use case. Its query engine and connection-
  pooling abstraction are a poor fit for a transaction-local GUC pattern,
  and Prisma has known friction with `SET`-style session-local config
  inside a transaction.

## 8. Final product architecture fit

This recommendation is intended to fit the final Azure-native CBC
architecture, not just the next PR:

- CBC's target architecture is Azure-native, with Azure Database for
  PostgreSQL as the system of record.
- The future runtime is Azure Container Apps, running Node, which is a
  good fit for a long-lived `pg.Pool` created once per process.
- The runtime database role should be least-privileged, such as `cbc_app`,
  not a superuser or service-role-equivalent credential.
- When Key Vault becomes the secret source, it should only change where
  the connection credential is read from. It should not require any
  change to the helper's design or to the `pg` dependency choice.
- The Supabase service-role `.from()` pattern remains legacy/current-state
  only. This recommendation does not extend or deepen that pattern.
- The future transaction helper must not use `SUPABASE_SERVICE_ROLE_KEY`.
  It must use a server-only least-privileged runtime database credential,
  such as one for `cbc_app`, once that role and credential path are
  approved.

## 9. Production risks

- Confirm the runtime that invokes this helper is a normal Node runtime,
  not an Edge runtime, since a raw TCP Postgres connection requires it.
- Pooling correctness: the helper must acquire one client from the pool
  and run the entire transaction on that one client.
- The same client must be used for every statement in the transaction -
  both `set_config` calls and the function call - never a different
  pooled client partway through.
- On any failure, the helper must `ROLLBACK` and release the client back
  to the pool, never leaving a connection in a bad transaction state.
- TLS is required for Azure Database for PostgreSQL and must be configured
  explicitly, not left to a default that may differ between local and
  Azure environments.
- Secret handling: the connection credential must be server-only, never
  logged, and never included in any client-bundled code.
- Observability: enough should be logged to debug failures, without
  logging the connection string or leaking raw database error text to
  end users.
- Retry behavior: only transient connection failures should ever be
  retried. A tenant-boundary refusal must never be retried.
- Concurrency and GUC isolation: under concurrent load, each request's
  `set_config` values must never leak onto a different request's
  connection. This is the single most important behavior to validate
  before any route wiring.

## 10. Local validation plan before route wiring

- Use a disposable local PostgreSQL database, never Azure, never
  `cbc_prod`.
- Validate the actual helper module's code later, once it exists - not
  raw psql commands only.
- Positive case: a valid same-org call returns the expected stub value.
- Missing context case: confirm the helper surfaces the expected refusal
  when session context is not set.
- Cross-tenant case: confirm the helper surfaces the expected refusal for
  a scan belonging to a different organization.
- Nonexistent scan case: confirm the helper surfaces the expected refusal
  when the scan id does not exist.
- Rollback cleanup case: deliberately force a failure mid-transaction and
  confirm the client is rolled back and released, not leaked.
- Concurrent multi-tenant calls case: run multiple calls with different
  user/org context at the same time, against a pool size greater than one,
  and confirm no cross-contamination of GUC state between them.
- No route wiring happens until all of the above pass.

## 11. Future ORM/query-builder blind spots

- This raw `pg` helper may intentionally coexist with a future ORM adopted
  for the rest of the app. That coexistence should be documented clearly
  where the helper lives, so it is not mistaken for an oversight.
- Avoid duplicate pool explosion: if a future ORM brings its own
  connection pool, the total number of connections against the database
  doubles unless the two pools are made aware of each other or sized
  accordingly.
- Migration tooling fragmentation must be considered later: if Drizzle or
  Prisma is adopted for the rest of the app, its migration system may not
  be aware of the existing hand-written SQL migrations used by Gate 003D
  onward. This is a question for whoever makes that later choice, not a
  Gate 003G problem to solve now.
- Do not refactor this helper into a future ORM unless the same-connection,
  transaction-local GUC safety demonstrated here can be proven again under
  the new tool, with the same concurrency testing described in Section 10.

## 12. Smallest future implementation PR

Only after founder approval of this document:

- Add the `pg` dependency.
- Add one server-only transaction module implementing the helper.
- Add local validation tests/scripts covering every case in Section 10.
- No route wiring in this PR.

## 13. Out of scope

- No package change happens in this PR.
- No implementation code is written in this PR.
- No route changes.
- No database migrations.
- No Azure infrastructure.
- No connection to `cbc_prod`.
- No Key Vault changes.
- No deploy.
- No broad ORM decision for the rest of the app - this document is scoped
  to this one transaction helper only.
