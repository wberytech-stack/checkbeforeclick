# Gate 003N - Disposable DB Validation of Expanded Fast-Path Function

## 1. Gate status

Gate 003N validates migration 004, `004_fast_path_function_write_expansion.sql`, against a disposable local PostgreSQL database only.

This gate does not approve applying migration 004 to `cbc_prod`, Azure PostgreSQL, or any other non-disposable database.

## 2. Background

Gate 003M added the draft migration that expands `public.app_record_fast_scan_result(...)` from the Gate 003D boundary-only stub into a write-capable function.

Gate 003N validates that expanded function before any runtime route wiring or production consideration.

## 3. Files added

This gate added:

- `infra/db/validation/gate-003n/004_validate_write_expansion.sql`

This follow-up note documents the gate because the validation script was pushed directly to `master` before the gate notes file was added.

## 4. Process note

Gate 003N was pushed directly to `master` at commit:

`bd49691 test: add Gate 003N disposable DB validation of expanded fast-path function`

That was not the preferred gate process. The expected process was branch, review, PR, merge.

Because the committed change is validation-only and does not modify migrations, runtime code, package files, Azure configuration, deploy configuration, or production settings, the commit is not reverted. This note records the process exception and closes the documentation gap.

## 5. Validation scope

The validation script covers:

- T01-T07: structural and security checks.
- T08-T11: context and authorization refusals.
- T12-T15: `p_status` restrictions.
- T16-T31: payload validation.
- T32-T37: write correctness.
- T38: rollback after post-update failure.
- T39-T40: one-shot completion/idempotency.
- T41: transaction-local GUC no-leak behavior.

## 6. T38 rollback method

T38 uses a disposable sabotage trigger on `public.vendor_results`.

The test creates a fresh pending scan, installs a trigger that raises an exception on `vendor_results` insert, calls `public.app_record_fast_scan_result(...)` with otherwise valid payload, and verifies that the scan remains pending, `completed_at` remains `NULL`, and no `vendor_results` or `evidence_items` rows persist.

This proves rollback after the function has passed validation and reached the write path.

## 7. T39/T40 one-shot validation

T39 validates that a repeated call after a scan is already `complete` is rejected and does not create duplicate child rows.

T40 validates that a repeated call after a scan is already `failed` is rejected and does not create duplicate child rows.

## 8. T41 GUC validation

T41 validates that transaction-local GUC state does not leak across transactions.

This matters because tenant context for the function must come only from transaction-local `app.current_user_id` and `app.current_organization_id`.

## 9. Out of scope

Gate 003N does not:

- Apply migration 004 to `cbc_prod`.
- Apply migration 004 to Azure PostgreSQL.
- Touch Key Vault.
- Touch production credentials.
- Modify runtime route code.
- Modify `app/api/scan/route.ts`.
- Remove Supabase.
- Change package files.
- Change existing migrations.
- Deploy anything.

## 10. Remaining before any non-disposable apply

Before migration 004 can be applied to any non-disposable environment, the following are still required:

- ChatGPT/founder review of the full T01-T41 validation output.
- Explicit approval for the target non-disposable environment.
- Resolution or explicit handling of the `cbcpgadmin` / Key Vault credential mismatch.
- A separate apply plan/runbook gate for the target environment.

## 11. Gate acceptance

Gate 003N can be marked closed only when:

- The validation script remains validation-only.
- The full T01-T41 output is reviewed.
- No production, Azure, Key Vault, deploy, runtime, package, or existing migration changes are included.
- This documentation note is committed and reviewed.
