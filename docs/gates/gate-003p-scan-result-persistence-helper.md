# Gate 003P - Server-Only Scan Result Persistence Helper

## 1. Gate status

Implementation and validation only. app/api/scan/route.ts is not
modified. Migration 004 is not applied to any real database. No Azure,
Key Vault, cbc_prod, deploy config, environment files, dependency files,
or package files are touched.

## 2. Purpose

Implement an isolated server-only helper that atomically persists a
fast-path scan final result through public.app_record_fast_scan_result
from migration 004.

This follows the Gate 003O plan and uses the withPgTransaction helper
from Gate 003G. This gate does not wire the helper into the scan route.

## 3. Files added

- src/server/scan/mapFastScanResultPayload.ts
- src/server/scan/recordFastScanResult.ts
- scripts/validate-scan-result-helper.ts
- docs/gates/gate-003p-scan-result-persistence-helper.md

## 4. Mapper design

mapFastScanResultPayload.ts exports pure mapper functions:

- mapVendorResults(...)
- mapEvidenceItems(...)

The mappers perform camelCase-to-snake_case transformation only. They do
not filter, drop, or validate entries. Malformed input is passed through
so migration 004 remains the authoritative validator and can reject
malformed payloads before any write occurs. This avoids silently hiding
caller bugs or losing evidence.

## 5. Transaction helper design

recordFastScanResult.ts begins with import "server-only".

It then:

1. Maps vendor and evidence payloads.
2. Opens one transaction through withPgTransaction.
3. On the same PoolClient, sets:
   - app.current_user_id
   - app.current_organization_id
4. Calls public.app_record_fast_scan_result(...) with explicit
   PostgreSQL casts and AS scan_id.
5. Returns { scanId }.

organization_id is never passed as a function argument. It reaches the
database only through the transaction-local GUC.

## 6. Error handling

The helper wraps database failures in RecordFastScanResultError with a
safe category:

- context_missing
- tenant_refused
- already_final
- validation_failed
- unknown

Raw DB RAISE EXCEPTION text is not returned directly to client-facing
surfaces.

## 7. Validation environment

Validation uses local Docker PostgreSQL only:

- Container name: cbc-gate-003p-postgres
- Database: gate_003p_validation
- Port: 55435
- Runtime role: cbc_app_validation
- Runtime role password: cbc_app_validation

The role is created before migration 004 so the conditional EXECUTE
grant lands during migration apply.

## 8. Validation command

Run manually, without adding a package.json script:

$env:NODE_OPTIONS="--conditions=react-server"
$env:CBC_DATABASE_URL="postgresql://cbc_app_validation:cbc_app_validation@localhost:55435/gate_003p_validation"
$env:CBC_DATABASE_SSL="false"
npx --yes tsx@4.23.0 scripts/validate-scan-result-helper.ts

## 9. Validation safety guards

The validation script refuses to run unless:

- CBC_DATABASE_URL is set.
- The URL does not contain production/Azure/Supabase markers.
- Host is localhost / 127.0.0.1 / ::1.
- Port is exactly 55435.
- Database is exactly gate_003p_validation.
- User is cbc_app_validation or cbc_app.
- NODE_OPTIONS includes --conditions=react-server.

The helper path is exercised through the least-privileged runtime role.
A separate local-only admin connection is used only for disposable seed
and verification queries.

## 10. Test cases

- T01: mapVendorResults transforms shape and preserves entries.
- T02: mapEvidenceItems transforms shape and preserves entries.
- T03: successful helper call writes scan final state, vendor results,
  and evidence items.
- T04: GUC sequence works on the same transaction/client for a fresh
  same-tenant scan.
- T05: rollback on post-update failure using a disposable sabotage
  trigger; no partial scan/vendor state remains.
- T06: empty identity values fail closed as context_missing.
- T07: cross-tenant call fails closed as tenant_refused.
- T08: repeated final-state call fails closed as already_final and
  creates no duplicate vendor rows.

## 11. Out of scope

- No route wiring.
- No app/api/scan/route.ts changes.
- No migration edits.
- No migration apply to any real database.
- No Azure, Key Vault, cbc_prod, deploy, or environment changes.
- No package/dependency changes.
- No removal or replacement of existing Supabase helpers.
- No audit-log behavior change.

## 12. Acceptance criteria

- All four approved files exist.
- recordFastScanResult.ts begins with import "server-only".
- The helper uses relative imports, not Next alias imports.
- The helper uses withPgTransaction.
- organization_id is never passed as a DB function argument.
- The function call uses explicit PostgreSQL casts and AS scan_id.
- Mapper functions preserve one output entry per input entry.
- Validation runs against disposable local PostgreSQL only.
- All 8 validation tests pass.
- No route, migration, package, Azure, Key Vault, production, or deploy
  files are changed.
