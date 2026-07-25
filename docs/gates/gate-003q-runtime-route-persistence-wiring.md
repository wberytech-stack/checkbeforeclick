# Gate 003Q - Runtime Scan Route Persistence Wiring

## Goal

Wire the synchronous URL/domain scan path to the Gate 003P
`recordFastScanResult` helper so terminal scan state, vendor results, and
evidence items are persisted in one database transaction.

## Changed files

- `app/api/scan/route.ts`
- `src/server/scan/mapFastScanResultPayload.ts`
- `docs/gates/gate-003q-runtime-route-persistence-wiring.md`

## Design

The route continues to resolve the user and organization from the authenticated
server-side context. It continues to create the scan, mark fast scans as
processing, and use `failScan` when the fast path throws. Slow-path Inngest
queuing is unchanged.

Both fast-path terminal outcomes now make one `recordFastScanResult` call. An
invalid target records a complete scan with an unknown verdict, zero risk, 10
confidence, one evidence item, and no vendor results. A normal provider run
records the final scan fields together with every provider result and evidence
item. Provider-native vendor verdicts are preserved, while the scan-level
verdict is constrained to safe, suspicious, dangerous, or unknown.

The route passes the server-resolved `userId` and `organizationId` to the
helper. It does not pass `organization_id` as a database-function argument;
the helper supplies tenant context transaction-locally.

The vendor mapper accepts provider-native verdict strings and arbitrary
JSON-serializable raw responses. Evidence severity remains restricted to the
six supported values.

## Validation

- `npm run build`
- `git diff --check`
- `git status --short`
- `git diff --stat`

## Out of scope

- Database migrations or database applies
- Package or lockfile changes
- Azure, Key Vault, production, deployment, or environment changes
- Provider behavior changes
- Authentication redesign
- Slow-path or Inngest rewrites
- Commits
