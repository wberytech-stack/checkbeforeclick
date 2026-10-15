# Gate 003T - Fast Scan Persistence Fail-Safe

## Goal

Implement Gate 003S decision D2. Gate 003Q wired `/api/scan` to the Gate 003P
`recordFastScanResult` helper before migration 004 was applied, and before
`CBC_DATABASE_URL` or the scan lifecycle existed in `cbc_prod`. As a result,
every URL and domain scan on `master` returns HTTP 500. This gate restores the
previous fast-path terminal writes by default. The 003Q integration stays in
place but is inert unless explicitly enabled.

## Changed files

- `src/server/scan/fastScanPersistenceFlag.ts` (new, `server-only`)
- `app/api/scan/route.ts`
- `docs/gates/gate-003t-fast-scan-persistence-fail-safe.md`

## Design

- `isFastScanPersistenceHelperEnabled()` returns `true` only when
  `CBC_FAST_SCAN_PERSISTENCE_HELPER` is exactly `enabled`. Any other value
  disables it: unset, empty, `true`, `1`, `Enabled`, or `" enabled"`. The flag
  is read on every request, server-side only, and has no `NEXT_PUBLIC_`
  prefix.
- Both fast-path terminal outcomes in `route.ts` (invalid target and provider
  run) now call `persistFastScanResult(input)` with the same
  `RecordFastScanResultInput` that Gate 003Q built.
  - **Flag enabled:** calls `recordFastScanResult(input)`, exactly as in
    Gate 003Q.
  - **Flag disabled (default):** runs the pre-003Q writes through `lib/data`
    in the same order: `insertEvidenceItems`, `insertVendorResults`, then
    `completeScan`. Row shapes are the same as before 003Q. The one difference
    is that `completeScan` now receives the normalized scan verdict
    (`safe | suspicious | dangerous | unknown`), which already matches the
    `scans_verdict_check` constraint.
- With the flag disabled, `recordFastScanResult` is never called, so
  `CBC_DATABASE_URL` is never read and the `pg` pool is never created.
  Importing the helper module has no side effects; the pool is created
  lazily.
- This gate restores the existing service-role calls exactly as they were
  before 003Q and adds no new Supabase usage. Slow-path, auth, status
  endpoint, helper, mapper, and migrations are unchanged.

## Enabling the helper

Setting `CBC_FAST_SCAN_PERSISTENCE_HELPER=enabled` in any real environment is
Gate 003S approval B. It is prohibited until all of the following have landed
and been approved:

- D1: scans are created in `cbc_prod`.
- D3: TLS verification in `src/server/db/postgres.ts`.
- D4: every scanning user has a `memberships` row.
- The Gate 003S schema apply has run.

## Validation (2026-10-15)

- `npm run build`: passed (compiled, TypeScript clean).
- Route test: a harness kept outside the repository and not committed. It
  imports the real `app/api/scan/route.ts` `POST` handler under
  `--conditions=react-server`. A Node module hook substitutes in-memory
  stand-ins for `@/lib/data`, `@/lib/supabase/server`, `@/inngest/client`,
  and `@/lib/scan/providers`, using two synthetic `clean` providers. F5 used a
  disposable Docker `postgres:16` database on `127.0.0.1:55438` with
  migrations 001-004 and `cbc_app_validation`
  (`NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`). The container was
  removed afterwards.

```text
PASS: F1 flag=undefined: URL scan -> 201 safe via legacy writes (evidence 2, vendor 2, completeScan); pg pool not created
PASS: F1 flag="true": URL scan -> 201 safe via legacy writes (evidence 2, vendor 2, completeScan); pg pool not created
PASS: F1 flag="1": URL scan -> 201 safe via legacy writes (evidence 2, vendor 2, completeScan); pg pool not created
PASS: F1 flag="": URL scan -> 201 safe via legacy writes (evidence 2, vendor 2, completeScan); pg pool not created
PASS: F1 flag="Enabled": URL scan -> 201 safe via legacy writes (evidence 2, vendor 2, completeScan); pg pool not created
PASS: F1 flag=" enabled": URL scan -> 201 safe via legacy writes (evidence 2, vendor 2, completeScan); pg pool not created
PASS: F2 flag unset: invalid target -> 201 unknown via legacy writes (1 evidence, 0 vendor, risk 0, confidence 10)
PASS: F3 flag unset: slow path (email) -> 201 and Inngest send, unchanged
PASS: F4 flag=enabled, CBC_DATABASE_URL unset: generic 500 + failScan; no legacy writes (helper path selected)
PASS: F5 flag=enabled + disposable DB as cbc_app_validation: 201 safe persisted by helper (2 vendor, 2 evidence); legacy writes not called
=== Gate 003T route fail-safe: 10 passed, 0 failed ===
```

All F1-F3 runs had `CBC_DATABASE_URL` unset, which is the state of every real
environment today.

Not validated: the real Supabase writes and auth. They were stand-ins here,
and this gate restores the pre-003Q calls unchanged. Validating them still
requires an authenticated local runtime, as described in Gate 003R.

## Out of scope

- Migrations, database applies, `cbc_prod`, Azure, Key Vault, deployment.
- Setting `CBC_DATABASE_URL` or `CBC_FAST_SCAN_PERSISTENCE_HELPER` anywhere.
- The TLS fix (D3) and the move of the scan lifecycle to `cbc_prod` (D1).
- Package or lockfile changes.
