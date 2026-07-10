# Gate 003J - Runtime Scan Write Discovery

## 1. Gate purpose

This is a discovery-only gate for the future runtime scan write
implementation. It inspects the current `/api/scan` route, its auth and
organization context sources, the existing Supabase-backed write path, and
the database functions that Gate 003I plans to use later.

This gate does not change runtime behavior, does not call
`public.app_record_fast_scan_result(...)`, does not wire
`withPgTransaction`, and does not modify route, package, migration, Azure,
`cbc_prod`, Key Vault, deploy, or environment files.

## 2. Files inspected

- `app/api/scan/route.ts`
- `app/api/scan/[id]/status/route.ts`
- `lib/data/index.ts`
- `lib/data/client.ts`
- `lib/supabase/server.ts`
- `lib/scan/scanHelpers.ts`
- `inngest/functions/processScan.ts`
- `src/server/db/postgres.ts`
- `infra/db/migrations/002_tenant_isolation.sql`
- `infra/db/migrations/003_fast_path_function.sql`
- Existing gate documents under `docs/gates/` for 003E through 003I

Searches also checked for explicit route runtime settings, Supabase client
usage, `set_config`, transaction-local app context functions, and
`public.app_record_fast_scan_result(...)` references.

## 3. Current /api/scan behavior summary

`app/api/scan/route.ts` exports `POST` and `GET`.

`POST` currently:

1. Creates a Supabase SSR auth client with `createClient()` from
   `lib/supabase/server.ts`.
2. Calls `authClient.auth.getUser()`.
3. Rejects unauthenticated requests with `401`.
4. Resolves application user and organization context with
   `getUserOrgContext(user.id)`.
5. Parses JSON request body.
6. Validates `input_type` against `url`, `domain`, `email`, `header`,
   `signature`, and `batch`.
7. Validates `input` as a non-empty string no longer than 10,000
   characters.
8. Creates an initial scan row with `createScan(ctx.organizationId,
   ctx.userId, input_type, cleanInput)`.
9. For `url` and `domain`, runs a synchronous fast path in the route.
10. For other input types, sends an Inngest `scan/requested` event with
    only `scan_id`.

`GET` on `/api/scan` returns `405`.

The fast path currently:

1. Marks the scan as `processing`.
2. Normalizes the scan target with `normalizeScanTarget`.
3. Writes invalid-target evidence and completes the scan as `unknown` if
   normalization fails.
4. Runs enabled fast providers in parallel.
5. Calculates confidence, risk score, and verdict.
6. Writes evidence rows.
7. Writes vendor result rows.
8. Updates the scan row to `complete`.
9. Marks the scan `failed` on unexpected fast-path errors.

## 4. Current authentication source

The scan route authenticates with Supabase Auth through the SSR server
client:

- `app/api/scan/route.ts` imports `createClient` from
  `@/lib/supabase/server`.
- `lib/supabase/server.ts` uses `createServerClient` from
  `@supabase/ssr`.
- The server client reads and writes cookies through `next/headers`.
- The route calls `authClient.auth.getUser()` and requires a returned
  `user`.

This is the current authentication source for `/api/scan`. Gate 003J did
not change it.

## 5. Current user identity source

The authenticated Supabase user id is read from `user.id` after
`authClient.auth.getUser()` succeeds.

The application user id used by scan writes comes from
`getUserOrgContext(user.id)` in `lib/data/index.ts`. That helper queries
the `users` table by `id = authUserId` and returns `data.id` as `userId`.

Current route behavior therefore derives `ctx.userId` server-side from
the authenticated Supabase user id and the database `users` row. It does
not read user id from the request body.

## 6. Current organization identity source

`getUserOrgContext(authUserId)` queries `users` for:

- `id`
- `organization_id`
- `role`
- `full_name`

It returns `organizationId` from the matched `users.organization_id`.

The scan route then passes `ctx.organizationId` into the current data
helpers. The request body accepted by `/api/scan` only includes `input`
and `input_type`; the route does not read `organization_id` from the
client request.

The current organization source is therefore server-side database state
resolved from the authenticated user id.

## 7. Current scan write path

Current writes are performed through `lib/data/index.ts`.

Initial scan creation:

- `createScan(orgId, userId, inputType, rawInput)` inserts into `scans`.
- It stamps `organization_id`, `user_id`, `input_type`, `raw_input`, and
  `status: "pending"`.
- It returns the inserted scan id.

Fast path writes:

- `markScanProcessing(orgId, scanId)` updates `scans.status` to
  `processing`, filtered by both `id` and `organization_id`.
- `insertEvidenceItems(orgId, rows)` inserts into `evidence_items` and
  stamps `organization_id` onto every row.
- `insertVendorResults(orgId, rows)` inserts into `vendor_results` and
  stamps `organization_id` onto every row.
- `completeScan(orgId, scanId, result)` updates `scans` with status,
  scores, verdict, completion time, and duration, filtered by `id` and
  `organization_id`.
- `failScan(orgId, scanId, durationMs?)` marks `scans` failed, also
  filtered by `id` and `organization_id`.

There is no current call from `/api/scan` to
`public.app_record_fast_scan_result(...)`.

## 8. Current Supabase usage in this path

The path uses two Supabase clients:

- `lib/supabase/server.ts` creates the SSR auth client using
  `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- `lib/data/client.ts` creates a privileged Supabase client using
  `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

`lib/data/client.ts` states that it is the only file allowed to read
`SUPABASE_SERVICE_ROLE_KEY`, and `lib/data/index.ts` is the data-access
chokepoint around that privileged client.

The current scan route imports data helpers from `@/lib/data`; it does
not import `createPrivilegedClient` directly. The current fast path uses
Supabase `.from(...).insert(...)` and `.from(...).update(...)` through
those helpers, not a direct PostgreSQL transaction.

Gate 003K must not use `SUPABASE_SERVICE_ROLE_KEY` for the new
`public.app_record_fast_scan_result(...)` path.

## 9. Current public.app_record_fast_scan_result(...) signature and migration source

The function is defined in:

- `infra/db/migrations/003_fast_path_function.sql`

Current signature:

```sql
public.app_record_fast_scan_result(
    p_scan_id               uuid,
    p_provider              text,
    p_provider_status       text,
    p_verdict               text,
    p_risk_score            integer,
    p_confidence_score      integer,
    p_ai_explanation        text,
    p_recommended_action    text,
    p_scan_duration_ms      integer    DEFAULT NULL,
    p_evidence_signal_type  text[]     DEFAULT '{}',
    p_evidence_severity     text[]     DEFAULT '{}',
    p_evidence_title        text[]     DEFAULT '{}',
    p_evidence_detail       text[]     DEFAULT '{}',
    p_evidence_score_impact integer[]  DEFAULT '{}',
    p_error_message         text       DEFAULT NULL
)
RETURNS uuid
```

The function is `LANGUAGE plpgsql`, `SECURITY DEFINER`, and pins
`search_path = public, pg_temp`.

The current migration describes the function as Gate 003D Slice 1:
boundary only. It reads transaction-local app context, verifies scan
ownership and membership, locks the scan row only after authorization
checks pass, and returns `p_scan_id`. It does not yet write to
`scans`, `vendor_results`, `evidence_items`, or audit tables.

`organization_id` is not part of the function signature and must not be
added as a function argument in Gate 003K.

## 10. Existing database context helper functions, if found

`infra/db/migrations/002_tenant_isolation.sql` defines the app context and
tenant helper functions used by the Gate 003D fast-path function:

- `public.app_current_user_id()` reads
  `current_setting('app.current_user_id', true)` and casts it to `uuid`.
- `public.app_current_org_id()` reads
  `current_setting('app.current_organization_id', true)` and casts it to
  `uuid`.
- `public.app_is_member(target_org uuid)` checks membership for
  `public.app_current_user_id()` in the target organization.
- `public.app_is_org_admin(target_org uuid)` checks owner/admin
  membership.
- `public.app_tenant_check(row_org uuid)` requires row org match with
  `public.app_current_org_id()` and membership.
- `public.app_tenant_admin_check(row_org uuid)` requires row org match and
  admin membership.

These helpers are designed around transaction-local session variables and
fail closed when context is missing.

## 11. Node.js runtime requirements for future pg usage

`src/server/db/postgres.ts` imports `server-only` and uses the Node.js
`pg` package. That helper requires a Node.js-compatible server runtime
because normal PostgreSQL TCP clients are not suitable for Edge-only
runtime execution.

Discovery did not find an explicit `export const runtime = "nodejs"` or
`export const runtime = "edge"` in the scan route or adjacent app/server
files. The current route therefore does not document the runtime
requirement explicitly.

Gate 003K should confirm the route runtime and add an explicit Node.js
runtime declaration if needed before importing or invoking the PostgreSQL
transaction helper from the route path.

## 12. Exact future implementation touchpoints

Likely Gate 003K touchpoints:

- `app/api/scan/route.ts`: wire the fast-path completion write to the new
  transaction-backed persistence path only after explicit approval.
- A new server-only persistence adapter, likely under `src/server/scan/`
  or `src/server/db/`, to keep SQL ordering centralized and auditable.
- `src/server/db/postgres.ts`: should be imported by the future adapter,
  but does not appear to require modification for the planned flow.
- Focused validation or tests for the future adapter, added only in Gate
  003K or a later implementation/test gate.
- Documentation for Gate 003K implementation and validation results.

The future implementation must preserve these touchpoints:

- `userId` comes from authenticated server-side context.
- `organizationId` comes from authenticated server-side context.
- `organization_id` is not passed to
  `public.app_record_fast_scan_result(...)`.
- `public.app_record_fast_scan_result(...)` remains the final
  tenant-boundary authority.
- App-side checks remain defense-in-depth only.

## 13. Risks and unknowns

- The current fast path creates a scan first, then performs multiple
  independent Supabase writes. Gate 003K must decide the exact boundary of
  what moves into the database function path, especially because the
  current function is still Slice 1 boundary-only and performs no result
  writes.
- The current route passes `organization_id` into the local `runFastPath`
  helper and data helpers. That is current behavior, but the future
  database function call must not pass `organization_id` as an argument.
- The future function argument mapping from current provider results to
  arrays such as `p_evidence_signal_type`, `p_evidence_severity`,
  `p_evidence_title`, `p_evidence_detail`, and
  `p_evidence_score_impact` needs precise implementation review.
- The function currently accepts one `p_provider` and
  `p_provider_status`, while the route can run multiple providers. Gate
  003K must define how multi-provider results are represented without
  inventing tenant arguments.
- No explicit route runtime setting was found. Node.js runtime must be
  confirmed before using `pg`.
- The current privileged Supabase data helpers use
  `SUPABASE_SERVICE_ROLE_KEY`. The new fast-path function call must avoid
  that path, but the surrounding route may still use existing helpers
  unless Gate 003K explicitly narrows the change further.
- Error response mapping for database function exceptions is not yet
  designed.
- Concurrency behavior around an already-created scan row and the
  function's `FOR UPDATE` lock should be validated in the implementation
  gate.

## 14. Items explicitly out of scope

This gate does not:

- Modify `app/api/scan/route.ts`.
- Modify `src/server/db/postgres.ts`.
- Modify `package.json`, `package-lock.json`, or `tsconfig.json`.
- Modify migrations.
- Create implementation code.
- Create tests.
- Call `public.app_record_fast_scan_result(...)`.
- Wire `withPgTransaction` into runtime behavior.
- Change authentication behavior.
- Change scan route behavior.
- Remove Supabase.
- Use `SUPABASE_SERVICE_ROLE_KEY` for any new path.
- Trust client-supplied tenant input.
- Pass `organization_id` as an argument to
  `public.app_record_fast_scan_result(...)`.
- Touch Azure, `cbc_prod`, Key Vault, deploy, or environment files.

## 15. Recommendation for Gate 003K

Gate 003K should be a design/scope decision gate, not an implementation
gate. The current `public.app_record_fast_scan_result(...)` function is
Gate 003D Slice 1 boundary-only: it validates transaction-local context,
checks tenant ownership and membership, locks the scan row after
authorization, and returns `p_scan_id`. It does not yet persist the fast
path result to `scans`, `vendor_results`, `evidence_items`, or audit
tables.

Gate 003K should decide one of these safe next paths:

Option A: Expand `public.app_record_fast_scan_result(...)` in a new
migration gate so it actually performs the fast-path persistence writes
inside the database function.

Option B: Add a narrow runtime adapter that calls the current
boundary-only database function only as an authorization and context
validation step, while leaving the existing Supabase writes unchanged for
now.

Option C: Create a more detailed implementation plan that splits database
function write expansion and route wiring into separate gates.

Gate 003K must explicitly preserve these constraints:

- Do not replace the current fast-path write path with a database
  function call until the function actually writes the needed scan,
  vendor, and evidence data.
- Do not call the current boundary-only function and assume persistence
  happened.
- Do not pass `organization_id` as a function argument.
- Do not use `SUPABASE_SERVICE_ROLE_KEY` for the new function-call path.
- Do not bundle migrations, route wiring, Azure, `cbc_prod`, Key Vault,
  deploy, or broad Supabase removal in one gate.
