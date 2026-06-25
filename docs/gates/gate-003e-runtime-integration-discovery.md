# Gate 003E - Runtime Integration Discovery Note

This note records the current state of the runtime scan path, as found by
inspecting the existing codebase, before any Gate 003E implementation work
begins. These findings reflect the founder's own inspection of the current
codebase; they have not been independently verified by Claude. This note is
discovery only - no app code, migrations, Azure config, or runtime files
are changed by it.

## 1. Current scan route

The current scan route is `app/api/scan/route.ts`.

## 2. Auth mechanism

Auth uses Supabase Auth via `createClient().auth.getUser()`.

## 3. Org context resolution

Org context is resolved server-side via `getUserOrgContext(user.id)`.

## 4. Fast path calls

The fast path currently calls the following data-layer functions:

- `createScan`
- `markScanProcessing`
- `insertEvidenceItems`
- `insertVendorResults`
- `completeScan`
- `failScan`

## 5. Data layer location

The data layer lives at `lib/data/index.ts`.

## 6. Privileged DB access

Privileged DB access goes through `lib/data/client.ts`.

## 7. Privileged client construction

`createPrivilegedClient()` uses the Supabase service role key together with
`@supabase/supabase-js`.

## 8. No direct SQL transaction client present

`package.json` has no direct Postgres transaction client such as `pg`,
`postgres`, `kysely`, `drizzle`, or `prisma`.

## 9. Discovery conclusion

Gate 003E implementation cannot be safely done using the current Supabase
`.from()` helper pattern. Gate 003E requires a short SQL transaction that
sets `app.current_user_id` and `app.current_organization_id` as
transaction-local config before calling
`public.app_record_fast_scan_result(...)` in that same transaction. The
Supabase `.from()` helper pattern does not provide a way to run
`set_config(...)` and a function call inside one guaranteed transaction
boundary.

## 10. Recommendation

Implementation should be deferred until a proper server-only SQL
transaction path is designed, likely as a separate gate or slice. No new
dependency (such as a Postgres transaction client) should be added without
explicit founder approval. This note does not select or recommend a
specific library.

## 11. Azure target alignment

This discovery note does not recommend preserving the current Supabase
service-role runtime pattern as the long-term architecture.

CBC's target architecture remains Azure-native, with Azure Database for
PostgreSQL as the system of record and a least-privileged runtime database
role such as `cbc_app` for application execution.

The current Supabase service-role client is documented here only as the
existing codebase state that must be migrated away from. Gate 003E
implementation should move toward the Azure PostgreSQL runtime model, not
deepen dependency on the old Supabase data-access pattern.

## 12. Scope reminder

This note is discovery only. No app code, no database migrations, no Azure
config, no connection to `cbc_prod`, no Key Vault changes, and no deploy are
part of this note or this branch.


