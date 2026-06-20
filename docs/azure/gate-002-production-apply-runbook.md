# Gate 002 - Production Apply Runbook

> EXECUTION RUNBOOK ONLY.
>
> This runbook does **not** approve production execution.
> Applying Gate 002 to `cbc_prod` still requires separate explicit approval:
>
> ```text
> Approve Gate 002 production apply to cbc_prod
> ```
>
> Until that approval is explicitly given, do **not** run production DDL.

## 0. Scope

This runbook describes the exact operator flow for applying:

```text
infra/db/migrations/002_tenant_isolation.sql
```

to:

```text
Azure PostgreSQL server: pg-cbc-prod-cc-001.postgres.database.azure.com
Production database: cbc_prod
```

This runbook must not be used to:

* Create the final `cbc_app` runtime role.
* Move application traffic.
* Import production data.
* Change DNS, Front Door, Container Apps, or runtime configuration.
* Run app traffic against `cbc_prod`.
* Bypass RLS.

## 1. Current expected pre-apply state

Expected Git state:

```text
Branch: audit/azure-current-state
Working tree: clean
Origin: aligned
```

Expected latest commits:

```text
7ec4e12 docs: harden Gate 002 production apply guardrails
140c405 docs: add Gate 002 production apply plan
3c04133 docs: record Gate 002 dry-run results
ba374d0 infra: add Gate 002 tenant isolation migration
```

Expected production database state:

```text
cbc_prod has 001 baseline only.
Gate 002 is not applied to cbc_prod.
Application traffic remains unchanged.
cbc_app runtime role does not exist.
```

## 2. Hard stop conditions

Stop immediately if any of the following are true:

* Current branch is not `audit/azure-current-state`.
* Git working tree is not clean.
* Local branch is not aligned with origin.
* Target database is not confirmed as `cbc_prod`.
* Target server is not confirmed as `pg-cbc-prod-cc-001.postgres.database.azure.com`.
* Azure PostgreSQL restore posture is not confirmed.
* The operator is unsure which database session is connected.
* Any SQL command errors during production apply.
* Any validation result is unexpected.

## 3. Pre-execution Git checks

Run:

```powershell
git status --short
git status -sb
git log --oneline -4
```

Expected:

```text
git status --short
# no output

git status -sb
## audit/azure-current-state...origin/audit/azure-current-state

git log --oneline -4
7ec4e12 docs: harden Gate 002 production apply guardrails
140c405 docs: add Gate 002 production apply plan
3c04133 docs: record Gate 002 dry-run results
ba374d0 infra: add Gate 002 tenant isolation migration
```

## 4. Confirm migration file exists

Run:

```powershell
Test-Path infra\db\migrations\002_tenant_isolation.sql
Get-Item infra\db\migrations\002_tenant_isolation.sql | Select-Object FullName, Length, LastWriteTime
```

Expected:

```text
True
```

## 5. Confirm no local migration edits

Run:

```powershell
git diff -- infra/db/migrations/002_tenant_isolation.sql
git diff --cached -- infra/db/migrations/002_tenant_isolation.sql
```

Expected:

```text
# no output
```

## 6. Confirm Azure PostgreSQL restore posture

Before production apply, confirm the Azure PostgreSQL server has an available restore point or backup posture.

This confirmation may be done in Azure Portal or Azure CLI.

Minimum evidence to record after confirmation:

```text
Server: pg-cbc-prod-cc-001
Backup/restore posture: confirmed
Confirmation method: Azure Portal or Azure CLI
Timestamp:
Operator:
```

Do not proceed if restore posture is unknown.

## 7. Set session-scoped database password

Use session memory only.

Do not write the password to files.
Do not commit it.
Do not paste it into documentation.

PowerShell pattern:

```powershell
$dbPassword = Read-Host "Enter Azure PostgreSQL password" -AsSecureString
$BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($dbPassword)
$plainPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
$env:PGPASSWORD = $plainPassword
```

After this, do not print `$plainPassword`.

## 8. Define connection variables

Set these variables:

```powershell
$server = "pg-cbc-prod-cc-001.postgres.database.azure.com"
$db = "cbc_prod"
$user = "<MIGRATION_ADMIN_USER>"
$port = "5432"
$migration = "infra\db\migrations\002_tenant_isolation.sql"
$timestamp = Get-Date -Format "yyyyMMddTHHmmssZ"
$logFile = "docs\azure\gate-002-production-apply-$timestamp.log"
```

Replace:

```text
<MIGRATION_ADMIN_USER>
```

with the actual migration/admin user.

Do not use a runtime app role for migration execution.

## 9. Read-only connection identity check

Run:

```powershell
psql "host=$server port=$port dbname=$db user=$user sslmode=require" `
  -v ON_ERROR_STOP=1 `
  -c "SELECT current_database() AS database, current_user AS user_name, inet_server_addr() AS server_addr, version() AS postgres_version;"
```

Expected:

```text
database = cbc_prod
user_name = migration/admin user
server_addr = Azure PostgreSQL address
postgres_version = PostgreSQL version
```

Stop if `current_database()` is not `cbc_prod`.

## 10. Optional pre-apply object check

Run:

```powershell
psql "host=$server port=$port dbname=$db user=$user sslmode=require" `
  -v ON_ERROR_STOP=1 `
  -c "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name;"
```

Purpose:

```text
Confirm the 001 baseline schema is present before applying Gate 002.
```

## 11. Apply Gate 002 migration

Only run this step after explicit approval has been given.

Required approval phrase:

```text
Approve Gate 002 production apply to cbc_prod
```

Apply command:

```powershell
psql "host=$server port=$port dbname=$db user=$user sslmode=require" `
  -v ON_ERROR_STOP=1 `
  -f $migration *>&1 | Tee-Object -FilePath $logFile
```

Stop immediately if any error appears.

Do not retry blindly.

## 12. Post-apply object validation

Run:

```powershell
psql "host=$server port=$port dbname=$db user=$user sslmode=require" `
  -v ON_ERROR_STOP=1 `
  -c "SELECT schemaname, tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
```

Expected:

```text
Tenant-scoped tables have rowsecurity enabled where required by Gate 002.
```

## 13. Post-apply function/policy validation

Run:

```powershell
psql "host=$server port=$port dbname=$db user=$user sslmode=require" `
  -v ON_ERROR_STOP=1 `
  -c "SELECT schemaname, tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname;"
```

Expected:

```text
Gate 002 RLS policies exist on tenant-scoped tables.
```

## 14. Production RLS smoke-test posture

Production RLS smoke testing must use:

```text
non-owner role
NOBYPASSRLS
temporary validation-only role
```

The validation role must not be the final `cbc_app` runtime role.

The validation role must be dropped after smoke testing.

## 15. Validation expectations

The production validation should confirm:

| Check                                   | Expected |
| --------------------------------------- | -------- |
| 001 baseline remains intact             | PASS     |
| Gate 002 objects exist                  | PASS     |
| RLS enabled on tenant-scoped tables     | PASS     |
| Missing tenant context denied           | PASS     |
| Wrong organization context denied       | PASS     |
| Own-tenant SELECT allowed               | PASS     |
| Cross-tenant SELECT denied              | PASS     |
| Cross-tenant INSERT denied              | PASS     |
| Cross-tenant UPDATE denied              | PASS     |
| Membership recursion avoided            | PASS     |
| Unauthorized membership mutation denied | PASS     |
| Owner membership mutation allowed       | PASS     |
| Audit log append allowed                | PASS     |
| Audit log delete denied                 | PASS     |
| Bootstrap mismatch denied               | PASS     |
| Bootstrap session-user allowed          | PASS     |

## 16. Clear secrets after execution

Run:

```powershell
Remove-Variable plainPassword -ErrorAction SilentlyContinue
Remove-Variable dbPassword -ErrorAction SilentlyContinue
Remove-Variable BSTR -ErrorAction SilentlyContinue
Remove-Item Env:\PGPASSWORD -ErrorAction SilentlyContinue
```

## 17. Result documentation

After production apply and validation, create a result document:

```text
docs/azure/gate-002-production-apply-results.md
```

The result document must include:

```text
Date/time:
Operator:
Git commit:
Target server:
Target database:
Migration file:
Apply result:
Validation result:
Temporary validation role dropped:
Password variables cleared:
Application traffic moved: No
Data imported: No
cbc_app created: No
```

## 18. Current decision

This runbook is prepared for review only.

Current decision remains:

```text
Gate 002 production apply is not approved.
cbc_prod remains on 001 baseline only.
Gate 002 is not applied to cbc_prod.
Application traffic remains unchanged.
```
