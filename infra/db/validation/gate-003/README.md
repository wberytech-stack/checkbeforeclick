# Gate 003B Runtime Role Validation

> VALIDATION ARTIFACTS ONLY.
> These scripts are for disposable database validation before production role/grant execution.
> Do not run these scripts against cbc_prod unless a later production execution gate explicitly approves it.

## Purpose

Gate 003B validates the Azure PostgreSQL runtime role model for CheckBeforeClick user/API access.

The immediate validation target is:

* cbc_app

The future worker target remains:

* cbc_worker

However, cbc_worker validation is intentionally deferred until the real worker/queue migration is designed.

## Scope decision

Gate 003B will fully validate cbc_app.

Gate 003B will not create or validate cbc_worker worker functions yet.

Reason:

The current worker path reloads organization_id from the trusted scan row in application code. Moving that enforcement into dedicated database worker functions is the right long-term direction, but those functions should be designed alongside the actual Azure worker/queue migration, not guessed in advance.

Gate 003B must not validate fake worker functions that may not match the final worker implementation.

## Relationship to Gate 002 validation

Gate 002 already validated core tenant isolation using a disposable runtime-like role named cbc_app_validation.

Gate 003B builds on that work.

Gate 003B focuses on the production-intended user/API runtime role:

* cbc_app

## Target architecture reminder

The approved target architecture still uses two runtime roles:

* cbc_app for user/API request paths
* cbc_worker for background scan processing

Both roles must eventually be:

* non-owner
* NOBYPASSRLS
* least privilege
* unable to disable RLS
* unable to bypass tenant isolation

## Required preconditions

The disposable validation database must already have:

* 001_initial_schema.sql applied
* 002_tenant_isolation.sql applied
* no production customer data
* no live app traffic

## Planned validation files

* 001_create_cbc_app_validation_role.sql
* 002_seed_synthetic_tenants.sql
* 003_validate_cbc_app_rls.sql
* 004_cleanup.sql

## cbc_app validation goals

The cbc_app role must prove:

* role is NOBYPASSRLS
* role owns no tenant tables
* no context means no tenant access
* valid user/org context can access only same-org rows
* wrong-org context is denied
* cross-tenant read is denied
* cross-tenant write is denied
* tenant-scoped writes require correct organization_id
* dashboard-style reads return only same-org data
* scan-result-style reads return only same-org scan, evidence, and vendor rows
* scan-status-style reads return only same-org scan status
* scan creation can insert only for the resolved organization

## cbc_worker forward-looking note

cbc_worker remains part of the approved architecture, but is not fully validated in Gate 003B.

The worker migration gate must later validate:

* cbc_worker is NOBYPASSRLS
* cbc_worker owns no tenant tables
* cbc_worker does not get broad tenant-table access by default
* worker operations start from scan_id, not trusted queue organization_id
* worker functions reload trusted organization_id from scans
* worker functions cannot attach evidence/vendor rows to the wrong tenant
* worker functions cannot perform invalid scan state transitions

## Production boundary

Gate 003B success does not mean production roles are created.

Gate 003B success does not mean the app is cut over.

Gate 003B success only means the cbc_app runtime role model is validated in a disposable database and ready for a later production execution gate.

## Stop conditions

Stop immediately if validation shows:

* cbc_app has BYPASSRLS
* cbc_app owns tenant tables
* cbc_app can read tenant data without context
* cbc_app can cross-read tenant data
* cbc_app can cross-write tenant data
* cbc_app can use session-level SET instead of transaction-bound SET LOCAL
* validation requires production customer data
* output logs expose secrets
