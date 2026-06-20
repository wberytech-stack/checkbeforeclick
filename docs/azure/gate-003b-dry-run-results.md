# Gate 003B - Disposable DB Validation Results

Date: 2026-06-17
Branch: `audit/azure-current-state`
Commit at execution: `30b1584 docs: add Gate 003B disposable DB execution plan`
Target database: `cbc_003_validation`
Production database: `cbc_prod`
Production touched: **NO**

## Result

**PASS**

Gate 003B disposable DB validation completed successfully against `cbc_003_validation`.

The run validated the target `cbc_app` runtime role model using a throwaway role named `cbc_app_validation`.

## Boundary confirmation

This run did **not**:

* touch `cbc_prod`
* create production runtime roles
* move application traffic
* pause Supabase
* import production data
* change DNS
* change Azure Front Door
* change Azure Container Apps
* change production secrets

The disposable DB `cbc_003_validation` was dropped after successful cleanup.

## Execution summary

### Step 0 - Pre-flight

Passed.

* Git branch was clean and synced.
* Expected HEAD was confirmed:

  * `30b1584 docs: add Gate 003B disposable DB execution plan`
* SQL validation scripts were checked for stray Markdown artifacts.
* No `##` heading artifacts were found.
* No triple-backtick code fences were found.

### Step 1 - Disposable DB creation

Passed.

* Connected to maintenance DB: `postgres`
* User: `cbcpgadmin`
* Confirmed `cbc_003_validation` did not already exist.
* Created `cbc_003_validation`.

### Step 2 - Disposable DB identity check

Passed.

Confirmed connection target:

```text
current_database  | current_user
------------------+-------------
cbc_003_validation | cbcpgadmin
```

### Step 3 - Baseline schema

Passed.

Applied:

```text
infra/db/migrations/001_initial_schema.sql
```

Result:

* Script completed with `COMMIT`.
* No `ERROR`.
* 10 baseline public tables confirmed:

  * `alerts`
  * `audit_log`
  * `evidence_items`
  * `organizations`
  * `scan_cache`
  * `scan_feedback`
  * `scans`
  * `users`
  * `vendor_results`
  * `watchlist`

### Step 4 - Tenant isolation migration

Passed.

Applied:

```text
infra/db/migrations/002_tenant_isolation.sql
```

Result:

* Script completed with `COMMIT`.
* No `ERROR`.
* Expected notice appeared:

  * `Role cbc_app not present; skipping grants.`
* Expected fresh-DB policy drop notices appeared.
* RLS verification passed:

  * tenant tables had `rowsecurity = true`
  * `scan_cache` had `rowsecurity = false`, expected because it is global/internal cache

Confirmed RLS state:

```text
alerts         | true
audit_log      | true
evidence_items | true
memberships    | true
organizations  | true
scan_cache     | false
scan_feedback  | true
scans          | true
users          | true
vendor_results | true
watchlist      | true
```

### Step 5 - Create validation role and grants

Passed.

Applied:

```text
infra/db/validation/gate-003/001_create_cbc_app_validation_role.sql
```

Result:

* Database guard: `PASS`
* `cbc_app_validation` role security: `PASS`
* Role is:

  * non-superuser
  * no createdb
  * no createrole
  * `NOBYPASSRLS`
* Role owns no tenant tables: `PASS`
* `scan_cache` not granted to `cbc_app_validation`: `PASS`
* RLS still enabled on tenant tables: `PASS`
* Completion marker:

  * `GATE_003B_001_CREATE_CBC_APP_VALIDATION_ROLE_COMPLETE | PASS`

Confirmed role state:

```text
cbc_app_validation | rolbypassrls=false | rolsuper=false
```

### Step 6 - Seed synthetic tenants

Passed.

Applied:

```text
infra/db/validation/gate-003/002_seed_synthetic_tenants.sql
```

Seed counts:

```text
organizations  | 2
users          | 3
memberships    | 3
scans          | 2
vendor_results | 2
evidence_items | 2
scan_feedback  | 2
watchlist      | 2
alerts         | 2
audit_log      | 2
scan_cache     | 1
```

Result:

* Seed count check: `PASS`
* Completion marker:

  * `GATE_003B_002_SEED_SYNTHETIC_TENANTS_COMPLETE | PASS`

### Step 7 - cbc_app RLS validation matrix

Passed.

Applied:

```text
infra/db/validation/gate-003/003_validate_cbc_app_rls.sql
```

Result:

* Database guard: `PASS`
* Role security: `PASS`
* Role owns no tenant tables: `PASS`
* No-context tenant reads denied: `PASS`
* Org A user sees only Org A data: `PASS`
* Org B user sees only Org B data: `PASS`
* Wrong-org context denied: `PASS`
* Dashboard-style same-org counts: `PASS`
* Scan result child rows scoped to same org: `PASS`
* Cross-tenant scan result denied: `PASS`
* Scan status read scoped to same org: `PASS`
* Same-org scan creation allowed: `PASS`
* Cross-org scan creation denied: `PASS`
* `cbc_app_validation` cannot update scans: `PASS`
* `cbc_app_validation` cannot insert `vendor_results`: `PASS`
* `cbc_app_validation` cannot insert `evidence_items`: `PASS`
* `cbc_app_validation` cannot read `scan_cache`: `PASS`
* Same-org feedback insert allowed: `PASS`
* Cross-org feedback insert denied: `PASS`
* Membership SELECT recursion re-check: `PASS`
* Member membership mutation denied: `PASS`
* Owner/admin direct membership mutation denied under narrow `cbc_app` grants: `PASS`
* `audit_log` UPDATE denied: `PASS`
* `audit_log` DELETE denied: `PASS`
* Bootstrap mismatch denied under `cbc_app` context: `PASS`

Completion marker:

```text
GATE_003B_003_VALIDATE_CBC_APP_RLS_COMPLETE | PASS
```

Additional log scan:

```text
findstr /I "FAIL ERROR" gate-003b-step5-create-role.log gate-003b-step6-seed.log gate-003b-step7-validate.log
```

Result: no output.

### Step 9 - Cleanup

Passed.

Applied:

```text
infra/db/validation/gate-003/004_cleanup.sql
```

Result:

* Database guard: `PASS`
* `cbc_app_validation` role removed: `PASS`
* Validation data removed from all seeded tables: `PASS`
* Completion marker:

  * `GATE_003B_004_CLEANUP_COMPLETE | PASS`

Cleanup counts after script:

```text
organizations  | 0
users          | 0
memberships    | 0
scans          | 0
vendor_results | 0
evidence_items | 0
scan_feedback  | 0
watchlist      | 0
alerts         | 0
audit_log      | 0
scan_cache     | 0
```

### Disposable DB disposal

Passed.

Commands executed after reconnecting to `postgres`:

```sql
DROP DATABASE IF EXISTS cbc_003_validation;
```

Final confirmation:

```text
SELECT datname
FROM pg_database
WHERE datname = 'cbc_003_validation';

(0 rows)
```

## What this proves

Gate 003B proves that the target `cbc_app` runtime role model can enforce tenant isolation as a non-owner, non-superuser, `NOBYPASSRLS` role in a disposable Azure PostgreSQL database.

It also proves the intended fast-path denials:

* `cbc_app` cannot update scans directly
* `cbc_app` cannot insert `vendor_results`
* `cbc_app` cannot insert `evidence_items`
* `cbc_app` cannot read `scan_cache`

These denials are expected under the target architecture.

## Important implementation dependency

The current application still has synchronous fast-path processing in:

```text
app/api/scan/route.ts
```

That current path may update scans and insert `vendor_results` / `evidence_items` during the request path.

Therefore, before the real application can run using the narrow `cbc_app` runtime role, scan processing must move out of the API request path and into the worker path, or into explicitly designed controlled database functions in a later worker/admin gate.

Gate 003B validates the target `cbc_app` model. It does not prove that the current app code can run unchanged on `cbc_app`.

## Final status

Gate 003B disposable DB validation: **PASS**

Next gate must remain separate and explicitly approved.
