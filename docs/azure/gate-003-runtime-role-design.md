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
