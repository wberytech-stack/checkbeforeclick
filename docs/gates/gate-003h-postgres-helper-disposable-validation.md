# Gate 003H - PostgreSQL Transaction Helper Disposable Validation

## 1. Gate status

Validation only. No runtime route wiring, no migrations, no Azure, no
cbc_prod, no Key Vault, no deploy, no Supabase removal.

## 2. Purpose

Validate the actual `withPgTransaction` helper from
`src/server/db/postgres.ts` against a disposable local PostgreSQL
database before the helper is wired into any runtime scan result flow.

## 3. Why NODE_OPTIONS is required

The helper begins with `import "server-only"`, which throws outside the
Next.js server runtime unless the `react-server` condition is active.
Running the script with `NODE_OPTIONS=--conditions=react-server` tells
Node to resolve the `react-server` export condition, which allows
`server-only` to resolve safely. This does not weaken the production
guard - it exercises the real helper in a controlled local context.

## 4. Validation setup

Start a dedicated disposable local PostgreSQL container:

```powershell
docker rm -f cbc-gate-003h-postgres 2>$null
docker run --name cbc-gate-003h-postgres `
  -e POSTGRES_PASSWORD=postgres `
  -e POSTGRES_DB=gate_003h_validation `
  -p 55433:5432 `
  -d postgres:16
```

Wait a few seconds for the container to start, then run:

```powershell
$env:CBC_DATABASE_URL="postgresql://postgres:postgres@localhost:55433/gate_003h_validation"
$env:CBC_DATABASE_SSL="false"
$env:NODE_OPTIONS="--conditions=react-server"
npm run validate:pg-helper
```

Cleanup after validation (pass or fail):

```powershell
Remove-Item Env:CBC_DATABASE_URL
Remove-Item Env:CBC_DATABASE_SSL
Remove-Item Env:NODE_OPTIONS
docker rm -f cbc-gate-003h-postgres
```

## 5. Safety guards in the script

- Refuses to run if CBC_DATABASE_URL is not set.
- Refuses to run if CBC_DATABASE_URL contains: cbc_prod, azure,
  supabase, supabase.co, postgres.database.azure.com,
  pooler.supabase.com.
- Refuses to run if CBC_DATABASE_URL host is not localhost, 127.0.0.1,
  or ::1.
- Sets CBC_DATABASE_SSL=false automatically if not already provided.
- Creates and drops a disposable table pg_helper_validation only.
- Does not touch any existing tables, migrations, or app data.

## 6. Validation cases

T1 - Commit success:
- Inserts a row inside withPgTransaction.
- Verifies the row persisted after the transaction committed.
- Confirms the helper correctly issues COMMIT on success.

T2 - Rollback on thrown error:
- Inserts a row inside withPgTransaction.
- Throws a deliberate error inside the callback.
- Verifies the row is absent after the transaction.
- Confirms the helper correctly issues ROLLBACK on error.

T3 - Transaction-local set_config / current_setting GUC behavior:
- Inside one transaction, calls
  SELECT set_config('app.validation_marker', 'gate-003h', true).
- Reads it back using
  SELECT current_setting('app.validation_marker', true) on the same
  client in the same transaction.
- Verifies the value is 'gate-003h'.
- Confirms transaction-local GUC state is visible on the same physical
  connection within one transaction. This is the exact behavior
  required for future set_config calls that will set
  app.current_user_id and app.current_organization_id before calling
  the Gate 003D database function.

## 7. What this gate does not do

- Does not wire the helper into app/api/scan/route.ts.
- Does not call public.app_record_fast_scan_result(...).
- Does not set production app.current_user_id or
  app.current_organization_id GUCs.
- Does not touch migrations.
- Does not touch Azure, cbc_prod, Key Vault, or deploy.
- Does not remove or replace Supabase.
- Does not change auth behavior.
- Does not pass organization_id as a runtime function argument.
- Does not broaden tenant trust to the client.

## 8. Known failure from first run attempt

During Gate 003H development, the first validation attempt failed for
two expected/environmental reasons:

1. PostgreSQL was not listening on localhost:5433 - the cbc-mcp-postgres
   container was not running. Resolved by using a dedicated disposable
   container on port 55433.
2. import "server-only" threw outside Next.js runtime. Resolved by
   running with NODE_OPTIONS=--conditions=react-server. This proves the
   server-only guard is working correctly.

## 9. Future gate

After this validation passes, the next gate will wire the helper into
the runtime scan result flow, setting transaction-local
app.current_user_id and app.current_organization_id via set_config
before calling public.app_record_fast_scan_result(...) inside the same
transaction using the same client.

## 10. Acceptance criteria

- T1, T2, and T3 all print PASS.
- Script exits 0.
- Script prints GATE 003H VALIDATION PASSED.
- No production, Azure, Supabase, or cbc_prod URL was used.
- No non-localhost host was used.
- No existing tables or app data were touched.
- No route wiring occurred.
- Container cbc-gate-003h-postgres removed after validation.
