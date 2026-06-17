# Gate 003 - Runtime Role and Application Connection Design

> DESIGN DOCUMENT ONLY. No execution is approved by this document.
>
> Gate 003 must not create roles, apply grants, change app configuration, move traffic, import data, or point any live application traffic at `cbc_prod` until a separate runbook and explicit approval exist.
>
> Gate 002 is complete. Gate 003 starts from production database tenant-isolation machinery already installed and validated.

## 0. Gate 003 purpose

Gate 003 designs the runtime enforcement path for CheckBeforeClick on Azure PostgreSQL.

Gate 002 installed database-enforced tenant isolation. Gate 003 must prove the real application runtime path can safely operate under that isolation.

The critical risk is not only database grants. The critical risk is application context.

If the app connects as `cbc_app` but fails to set the correct tenant context inside the same transaction as each query, RLS will deny access and the app may appear broken. That is a safe security failure, but it is still a production reliability failure.

Therefore Gate 003 covers both:

* Runtime role and least-privilege database grants.
* Application-side transaction-bound context setting using `app.current_user_id` and `app.current_organization_id`.

## 1. Current known state

Production target:

* Server: `pg-cbc-prod-cc-001.postgres.database.azure.com`
* Database: `cbc_prod`
* PostgreSQL: `16.14`

Gate 002 completed and committed:

* Latest evidence commit: `3894d4b`
* Apply log: `docs/azure/gate-002-production-apply-20260616T192402Z.log`
* Results doc: `docs/azure/gate-002-production-apply-results.md`

Gate 002 created and validated:

* `memberships` table
* Tenant RLS policies
* Expected `app_*` helper functions as `SECURITY DEFINER`
* Temporary non-owner validation role test
* No runtime role
* No app traffic
* No data import

## 2. Hard boundaries

Gate 003 design does not approve execution.

Until a later approved runbook:

* Do not create `cbc_app`.
* Do not grant privileges to `cbc_app`.
* Do not change application connection strings.
* Do not change Key Vault secrets.
* Do not change Container Apps configuration.
* Do not change DNS.
* Do not change Front Door.
* Do not import data.
* Do not point application traffic at `cbc_prod`.
* Do not run live app traffic against `cbc_prod`.

## 3. Gate 003 should not include live cutover

Gate 003 should end with runtime-role readiness, not live production cutover.

Recommended split:

* Gate 003: runtime role, least-privilege grants, app transaction-context design, validation matrix, and runbook.
* Gate 004: controlled app cutover and rollback execution.

This keeps the first live traffic movement outside the role/grant design gate.

## 4. Runtime role design

The runtime database role should be named:

* `cbc_app`

Expected properties:

* Non-owner
* `NOBYPASSRLS`
* No superuser privileges
* No database ownership
* No schema ownership
* No table ownership
* No ability to disable RLS
* No broad DDL privileges
* Least-privilege DML only

The role should receive only the permissions required by the application.

Expected broad grant categories:

* `USAGE` on schema `public`
* Required DML on tenant tables
* Sequence usage only if required
* Function execution only where required

The grants should activate or mirror the conditional `cbc_app` grant block already embedded in Gate 002.

## 5. Application context design

The application must set tenant context before running tenant-scoped queries.

Required context values:

* `app.current_user_id`
* `app.current_organization_id`

The context must be transaction-bound.

Acceptable pattern:

* Open transaction.
* Set context using `SET LOCAL`.
* Execute tenant-scoped query or mutation.
* Commit or roll back transaction.

Unacceptable pattern:

* Session-level `SET` across pooled connections.
* Context set once globally at login.
* Context set in one connection and query executed on another.
* Trusting client-provided organization IDs without server-side membership verification.
* Falling back to admin/service-role queries for normal runtime traffic.

The safest application pattern is a shared data-access helper that wraps every tenant-scoped database operation in one transaction and sets the GUC values inside that transaction.

## 6. Connection pooling risk

Connection pooling is a major risk area.

If session-level settings are used with pooled connections, context can be missing, stale, or leaked between requests.

Therefore:

* Use transaction-scoped `SET LOCAL`.
* Ensure the same transaction executes both context-setting and the query.
* Avoid relying on persistent session state.
* Add tests that simulate repeated requests from different users/orgs.

## 7. RLS validation matrix

Gate 003 validation must test RLS as the real runtime role `cbc_app`.

Minimum matrix:

### No context

Expected result:

* Reads return zero tenant rows.
* Writes fail or affect zero rows.
* No cross-tenant data exposure.

### Valid user and valid organization context

Expected result:

* User can see only their organization.
* User can see only their own tenant scans, evidence, vendor results, feedback, alerts, and watchlist rows.
* User can insert only rows for their organization.

### Valid user with wrong organization context

Expected result:

* User sees zero rows for the wrong organization.
* User cannot insert or update rows for the wrong organization.

### Cross-tenant read attempt

Expected result:

* Tenant A user cannot read Tenant B data.

### Cross-tenant write attempt

Expected result:

* Tenant A user cannot insert, update, or delete Tenant B data.

### Admin role behavior

Expected result:

* Organization admin behavior works only inside that organization.
* Admin checks do not allow cross-tenant access.

### Membership check behavior

Expected result:

* Membership checks depend on `memberships`.
* No membership means no access.

## 8. Test data strategy

Because `cbc_prod` currently has no production tenant data, Gate 003 should not depend on existing production customer rows.

A safe validation strategy must be chosen before execution:

Option A:

* Use a disposable validation database restored or migrated to the same schema.
* Create synthetic tenants/users/memberships/scans.
* Validate `cbc_app` there first.

Option B:

* Use tightly controlled synthetic rows in `cbc_prod`.
* Clearly label them as Gate 003 validation rows.
* Delete them after validation.
* Only do this with explicit approval.

Preferred approach:

* Use disposable validation first.
* Use production only for final read-only or minimal smoke validation.

## 9. Application code areas to review

Gate 003 must identify and update the data-access layer before runtime cutover.

Areas to inspect:

* Database client creation
* API route handlers
* Scan submission path
* Scan result lookup path
* Organization/user lookup path
* Background worker database access
* Inngest or job-processing database access
* Any service/admin client usage
* Any direct SQL or Supabase-style client usage
* Any cache access that should remain global

The app must clearly separate:

* Runtime tenant-scoped access as `cbc_app`
* Migration/admin access
* Worker access if different
* Global cache access if intentionally non-tenant

## 10. Key Vault and app configuration design

Gate 003 must define how the runtime connection string is stored and rolled out.

Expected direction:

* Store `cbc_app` connection secret in Azure Key Vault.
* Inject into application runtime through managed configuration.
* Do not commit secrets.
* Do not paste secrets into documentation.
* Avoid local `.env` drift.
* Keep old connection available only as rollback, with strict handling.

Required rollback design:

* Ability to switch app connection back quickly.
* Clear owner/operator.
* Clear test after rollback.
* Clear decision point for rollback.

## 11. Cutover posture

Gate 003 should not perform final production cutover.

Before any cutover gate, the following must be true:

* `cbc_app` exists and is `NOBYPASSRLS`.
* Least-privilege grants are validated.
* App context wrapper exists and is tested.
* Positive and negative RLS matrix passes.
* Rollback path is documented and rehearsed.
* App can be tested in staging or controlled preview.
* No secrets are exposed.
* Observability/logging is ready.

## 12. Required Gate 003 deliverables

Gate 003 should produce, at minimum:

* Runtime role design
* Runtime role migration SQL
* App transaction-context design
* Validation SQL
* Dry-run results
* Production runbook
* Rollback plan
* Explicit approval checkpoint before execution

Recommended files:

* `docs/azure/gate-003-runtime-role-design.md`
* `infra/db/migrations/003_runtime_role.sql`
* `infra/db/validation/003_runtime_role_validation.sql`
* `docs/azure/gate-003-runtime-role-runbook.md`
* `docs/azure/gate-003-runtime-role-results.md`

## 13. Stop conditions

Stop immediately if:

* The branch is not clean.
* The target database is unclear.
* `cbc_app` would receive ownership or bypass RLS.
* A grant is broader than required.
* App queries require service/admin role to work.
* Context is not transaction-bound.
* RLS positive/negative matrix is incomplete.
* Rollback path is not documented.
* Any secret appears in logs, docs, shell history, or commits.
* Any step would move live traffic before approval.

## 14. Final Gate 003 success definition

Gate 003 is successful only when:

* Runtime role design is reviewed.
* `cbc_app` execution plan is least-privilege.
* App-side transaction context pattern is designed and tested.
* RLS is proven with the real runtime role in a safe environment.
* Cutover remains deferred to Gate 004.

Gate 003 does not mean the app is live on `cbc_prod`.

Gate 003 means the runtime enforcement path is ready for controlled cutover planning.

## 15. Current application data-access findings

A Gate 003 code inspection confirmed the current application still uses Supabase Auth and a centralized Supabase service-role data layer.

Current authentication/session path:

- `lib/supabase/server.ts`
- `lib/supabase/client.ts`
- `proxy.ts`
- `app/api/auth/login/route.ts`
- `app/auth/callback/route.ts`
- Dashboard and API routes use Supabase Auth user identity.

Current privileged data-access path:

- `lib/data/client.ts`
- `lib/data/index.ts`

`lib/data/client.ts` creates a privileged Supabase client using `SUPABASE_SERVICE_ROLE_KEY`.

This is intentionally centralized and currently acts as the backend data chokepoint. That is good for migration control, but it means current backend data access bypasses RLS.

Current application callers of `@/lib/data` include:

- `app/(dashboard)/dashboard/page.tsx`
- `app/(dashboard)/scan/[id]/page.tsx`
- `app/api/scan/[id]/status/route.ts`
- `app/api/scan/route.ts`
- `inngest/functions/processScan.ts`

The main tenant-scoped functions in `lib/data/index.ts` include:

- `getUserOrgContext`
- `createScan`
- `markScanProcessing`
- `completeScan`
- `failScan`
- `insertEvidenceItems`
- `insertVendorResults`
- `getScanById`
- `getScanStatus`
- `getEvidenceForScan`
- `getVendorResultsForScan`
- `getDashboardData`
- `loadScanForProcessing`

Existing safety properties:

- Data access is centralized.
- Most functions take `orgId`.
- Reads and updates filter by `organization_id`.
- Inserts stamp `organization_id`.
- Worker processing reloads `organization_id` from DB state instead of trusting event payload.

Gate 003 risk:

- The current Supabase service-role client bypasses RLS.
- Azure `cbc_app` cannot simply replace the Supabase service-role client without a new Postgres transaction wrapper.
- Supabase SDK-style `.from(...).select/insert/update` calls do not provide the required transaction-bound `SET LOCAL` pattern for Azure PostgreSQL RLS context.
- A direct connection-string flip would likely break reads/writes or silently fail RLS context requirements.

Gate 003 design implication:

- Do not hard-switch `lib/data` from Supabase service role directly to `cbc_app`.
- Build an Azure/Postgres runtime data adapter beside the current Supabase adapter.
- The Azure/Postgres adapter must wrap tenant-scoped operations in transactions.
- Each transaction must set:
  - `app.current_user_id`
  - `app.current_organization_id`
- Tenant-scoped queries must run in the same transaction as the context setting.
- Tests must prove no-context denial, valid-context success, and cross-tenant denial.

Worker design implication:

`inngest/functions/processScan.ts` currently calls `loadScanForProcessing(scan_id)` without user context, then writes scan results under the scan organization.

Under RLS, the worker path needs explicit design. Gate 003 should evaluate one of these models:

- `cbc_app` for both API and worker, with a controlled worker context pattern.
- Separate `cbc_worker` role, also `NOBYPASSRLS`, with narrow grants and RLS-compatible context.
- Temporary privileged worker access only if explicitly justified and isolated.

Preferred direction:

- Use `cbc_app` for user/API request paths.
- Consider a separate `cbc_worker` role for background scan processing.
- Both runtime roles should be non-owner and `NOBYPASSRLS`.
- Neither runtime role should bypass tenant isolation.
- Worker access must be validated with synthetic scan rows before any production traffic movement.

Additional security note:

Local `.env.local` is ignored by Git and not tracked, but secret values were exposed during terminal output review. Supabase service role and active Clerk secrets should be rotated before relying on them further.

## 16. Gate 003 architecture decision

Gate 003 will use a two-runtime-role architecture for Azure PostgreSQL readiness.

This decision separates user/API request traffic from asynchronous background worker processing.

### 16.1 Runtime roles

Gate 003 will design for two non-owner runtime roles:

- `cbc_app`
- `cbc_worker`

Both roles must be:

- `NOBYPASSRLS`
- non-superuser
- non-owner of the database
- non-owner of the schema
- non-owner of tenant tables
- unable to disable RLS
- unable to perform broad DDL
- granted only the minimum permissions required for their path

### 16.2 `cbc_app` purpose

`cbc_app` is the runtime role for user-facing and API request paths.

Expected callers include:

- dashboard page reads
- scan result page reads
- scan status API reads
- scan creation API writes
- future user-facing tenant features

`cbc_app` must use transaction-bound context for tenant isolation.

Each tenant-scoped database operation must run inside a transaction that sets:

- `SET LOCAL app.current_user_id = '<authenticated-user-id>'`
- `SET LOCAL app.current_organization_id = '<resolved-organization-id>'`

The tenant-scoped query must execute in the same transaction as the `SET LOCAL` statements.

`cbc_app` must not rely on session-level `SET` across pooled connections.

`cbc_app` must not trust organization IDs provided by the browser or client payload.

`cbc_app` must resolve the authenticated user to an allowed organization server-side before tenant-scoped access.

### 16.3 `cbc_worker` purpose

`cbc_worker` is the runtime role for asynchronous background processing.

Expected callers include:

- scan processing workers
- provider-result writers
- evidence writers
- scan completion/failure updates
- future queue-driven jobs

The worker path has a different trust model than user/API requests.

A worker begins from trusted queue state such as `scan_id`, not from a logged-in user session. Therefore, the worker must not pretend to be a normal human user unless a deliberate system-user model is explicitly designed.

The worker must not trust `organization_id` from queue payloads.

The worker must reload scan and organization context from trusted database state.

### 16.4 Worker access model

The preferred worker model is:

- `cbc_worker` is `NOBYPASSRLS`
- `cbc_worker` has no broad tenant-table DML by default
- `cbc_worker` receives narrow `EXECUTE` permission on controlled database functions
- worker functions validate scan ownership and operation safety internally

Preferred controlled functions include:

- `claim_scan_for_processing(scan_id)`
- `mark_scan_processing(scan_id)`
- `insert_scan_evidence(scan_id, rows)`
- `insert_vendor_results(scan_id, rows)`
- `complete_scan(scan_id, result)`
- `fail_scan(scan_id, reason)`

The exact function names and signatures may change during implementation design, but the security principle must remain:

> The worker should perform narrowly defined scan lifecycle operations, not arbitrary tenant-table reads and writes.

### 16.5 Worker function requirements

Worker database functions must verify:

- the scan exists
- the scan belongs to an organization
- the scan status transition is valid
- inserted evidence rows are stamped with the scan organization
- inserted vendor result rows are stamped with the scan organization
- caller-provided organization IDs cannot override trusted database state
- one tenant's scan cannot receive another tenant's evidence or vendor results

Worker functions may be `SECURITY DEFINER` only when necessary, and only if:

- owned by a controlled owner role
- search path is fixed
- input validation is explicit
- privileges are limited to the function surface
- direct table access remains restricted
- behavior is tested using `cbc_worker`

### 16.6 Why one runtime role is rejected

A single `cbc_app` role for both user/API and worker paths is not the preferred design because it mixes two different trust models.

User/API path:

- has authenticated user context
- has user ID
- has resolved organization ID
- represents a user acting inside an organization

Worker path:

- starts from queue event state
- may not have user context
- needs to reload scan organization from DB
- writes provider/evidence/completion records
- must not depend on browser/session identity

Combining these paths into one broad role increases audit risk and makes future least-privilege enforcement harder.

### 16.7 Rejected shortcut

Gate 003 explicitly rejects a direct connection-string flip from Supabase service-role access to `cbc_app`.

Reasons:

- current `lib/data` uses Supabase SDK service-role calls
- current data layer bypasses RLS
- Azure PostgreSQL requires transaction-bound `SET LOCAL` context
- the worker path has no natural human user context
- a simple flip would likely break app behavior or create unsafe exceptions

### 16.8 Required validation

Gate 003 must validate the two-role model against a disposable Azure PostgreSQL database before any production role/grant execution.

Validation must prove at minimum:

- `cbc_app` without context cannot read tenant data
- `cbc_app` with valid user/org context can read/write only that organization
- `cbc_app` with wrong org context is denied
- `cbc_app` cannot cross-read or cross-write tenant data
- `cbc_worker` cannot broadly read tenant tables
- `cbc_worker` can perform only approved scan lifecycle operations
- worker functions cannot write evidence/vendor rows across tenants
- neither role has `BYPASSRLS`
- neither role owns tenant tables
- neither role can disable RLS

### 16.9 Gate boundary

Gate 003 remains a readiness gate.

Gate 003 may design and validate:

- runtime roles
- least-privilege grants
- app/worker access model
- database function model
- disposable validation scripts
- app adapter implementation plan

Gate 003 must not:

- move live app traffic
- import Supabase production data
- point production app to `cbc_prod`
- change DNS
- change Front Door
- deploy Azure Container Apps for live traffic
- perform cutover

Controlled cutover belongs to Gate 004.
