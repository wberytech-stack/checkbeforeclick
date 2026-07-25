# Gate 003R - Runtime Smoke Validation Runbook

## Purpose

Gate 003Q changed the `/api/scan` fast path so its terminal scan state,
vendor results, and evidence items are persisted together through
`recordFastScanResult`, replacing the previous sequence of separate terminal
writes.

Gate 003R validates that wiring end to end in a local runtime before any more
code gates proceed. This gate is documentation and runtime observation only;
it does not change application or database state beyond ordinary test scans
created by the running application.

## Preconditions

Do not begin the smoke test until all of the following are true:

- The local `master` baseline is synced at commit `f82edbd` or newer, and the
  Gate 003Q wiring under test is present on the validation branch.
- `git status --short` produces no output before validation begins.
- The local application environment is available with its normal server-only
  runtime configuration. Do not add, edit, print, or capture secrets in this
  runbook.
- The database used by the active local runtime already contains
  `public.app_record_fast_scan_result` with the signature expected by the Gate
  003P helper. This runbook does not apply or repair the database function.
- The tester can sign in locally as a real test user whose server-resolved
  organization membership is valid.
- The application and, for slow-path checks, the local Inngest development
  service can be started using the repository's established commands.

Record the commit under test before starting:

```powershell
git rev-parse HEAD
git merge-base --is-ancestor f82edbd HEAD
git status --short
```

The ancestry command must exit `0`, and the status command must be empty.

## Evidence record

Create a test note outside the repository, or retain terminal and browser
history, containing:

- Date, tester, branch, and commit SHA.
- The exact command and output used to start the local application.
- The exact command and output used to start local Inngest, when applicable.
- For every scenario: input type, redacted test input if sensitive, request
  time, HTTP status, response body, and returned `scan_id`.
- The corresponding status endpoint response.
- Relevant scan, vendor-result, and evidence-item database query results when
  local read access is available.
- Any server or Inngest log lines needed to establish the observed behavior,
  with credentials and secrets removed.
- Optional screenshots of browser results or the Inngest event view.

Do not put tokens, cookies, connection strings, or other credentials in the
evidence record.

## Start the local runtime

Use the repository's normal local startup command. Capture the command and its
startup output, including the local URL and any startup error. For example, if
this is the established command:

```powershell
npm.cmd run dev
```

Sign in through the local browser. Use the authenticated browser UI for scans,
or reproduce its authenticated request with browser developer tools. Do not
manufacture a user ID or organization ID in the request: those identities must
be resolved by the server from the authenticated session.

For each returned scan ID, capture the UI result and the authenticated status
request:

```text
GET /api/scan/<scan_id>/status
```

## Scenario 1 - Fast URL scan

1. Submit a valid, controlled HTTP or HTTPS URL with `input_type` set to
   `url` through the authenticated local UI or API request.
2. Capture the `POST /api/scan` request and response.
3. Record the returned `scan_id` and scan-level verdict.
4. Query `GET /api/scan/<scan_id>/status` and capture the completed result.
5. If local database read access is available, run the row checks below for
   that scan ID.

Expected result:

- The POST returns HTTP `201` with
  `{ "scan_id": "...", "status": "complete", "verdict": "..." }`.
- The final verdict is one of `safe`, `suspicious`, `dangerous`, or `unknown`.
- The status endpoint shows the scan as complete and agrees with the POST.
- Vendor results retain provider-native verdicts such as `clean`, `skipped`,
  or `error`; they are not rewritten to the scan-level verdict vocabulary.
- Evidence and vendor rows correspond to the providers executed by the fast
  path.

## Scenario 2 - Fast domain scan

1. Submit a valid controlled domain name with `input_type` set to `domain`.
2. Capture the POST response, returned `scan_id`, and status endpoint result.
3. If available, capture the database row checks for this scan.

Expected result:

- The POST returns HTTP `201` with a complete result and a normalized verdict.
- The status endpoint reports the same completed scan.
- Vendor and evidence rows are persisted for the normalized provider run.
- Provider-native vendor verdicts remain intact.

## Scenario 3 - Invalid target path

1. Submit a URL or domain input that the existing target-safety normalization
   rejects. Use a benign local test value; do not probe internal or third-party
   infrastructure.
2. Capture the POST response, returned `scan_id`, and status endpoint result.
3. If available, capture the scan, evidence, and vendor row checks.

Expected result:

- The POST returns HTTP `201` with
  `{ "scan_id": "...", "status": "complete", "verdict": "unknown" }`.
- The persisted scan has status `complete`, verdict `unknown`, risk score `0`,
  and confidence score `10`.
- Exactly one evidence item describes the invalid target.
- Zero vendor-result rows exist for the scan.

## Scenario 4 - Slow-path queue regression check

With the local Inngest development service running, submit one representative
request for each slow-path input type:

- `email`
- `header`
- `signature`
- `batch`

For each request, capture the POST response, returned `scan_id`, application
log, and corresponding `scan/requested` event in the local Inngest view or
logs. Capture the status endpoint result at the point relevant to the existing
asynchronous behavior.

Expected result:

- The route returns HTTP `201` with a created `scan_id` using the existing
  slow-path response shape.
- A `scan/requested` event containing that scan ID is queued as before.
- The request is handled asynchronously; it does not enter the URL/domain
  `recordFastScanResult` path.
- No slow-path or Inngest behavior introduced by Gate 003Q is observed.

## Scenario 5 - Persistence dependency failure

This scenario is observational and must use a safe, already-misconfigured or
disposable local runtime. Do not rename, drop, revoke, replace, or apply any
database object as part of this gate.

If a local runtime is already available whose configured database lacks the
expected function, or whose runtime connection points to an incompatible
database, submit one fast URL or domain scan and capture:

- The HTTP response.
- The returned scan ID if the error response contains one.
- The application log with secrets and raw credentials removed.
- Status and related-row checks when possible.

Expected result:

- The fast request fails visibly; it must not report a successful complete
  result.
- The application returns its existing safe client-facing error rather than a
  raw database exception.
- The failed transactional call leaves no partially inserted vendor or
  evidence rows and no partially completed fast result.
- Existing route failure handling may mark the scan failed, but it must not
  disguise the missing function or database mismatch as a passing smoke test.

If no safe disposable mismatch is already available, record this scenario as
`not exercised`; do not create one by changing database or environment state.
The active runtime function prerequisite must still be verified for the
successful fast-path scenarios.

## Optional local database row checks

Use read-only queries through the established local database client. Replace
`<scan_id>` with the UUID returned by the route. Capture results without
exposing connection details.

```sql
SELECT id, organization_id, user_id, status, verdict,
       risk_score, confidence_score, scan_duration_ms, error_message
FROM public.scans
WHERE id = '<scan_id>'::uuid;

SELECT scan_id, organization_id, vendor_name, verdict,
       error_message, response_time_ms
FROM public.vendor_results
WHERE scan_id = '<scan_id>'::uuid
ORDER BY vendor_name;

SELECT scan_id, organization_id, signal_type, severity,
       title, score_impact
FROM public.evidence_items
WHERE scan_id = '<scan_id>'::uuid
ORDER BY signal_type, title;
```

Confirm that every returned child row has the same `organization_id` as the
scan. Do not use elevated access to alter rows during validation.

## Pass/fail criteria

Gate 003R passes only when all required scenarios and invariants are supported
by captured evidence:

- URL and domain fast scans each return HTTP `201` with a complete result and
  a normalized scan verdict.
- The invalid-target fast path returns HTTP `201` with verdict `unknown`, the
  required scores, one evidence item, and zero vendor results.
- Slow-path inputs return a created scan ID and queue through Inngest using the
  existing behavior.
- All requests require normal authentication, and persisted organization and
  user ownership comes from server-resolved context. No tenant or auth bypass
  is observed.
- A successful fast scan has a coherent final scan and matching child rows;
  a failed `recordFastScanResult` call leaves no partial fast-path terminal
  writes.
- A missing DB function, incompatible signature, runtime database mismatch, or
  other persistence prerequisite failure is recorded as a failure, never
  hidden or waived as a successful result.

Any unexpected HTTP status or response shape, inconsistent status endpoint
result, missing/duplicate child rows, tenant mismatch, partial terminal write,
or unqueued slow-path event fails the gate. A scenario marked `not exercised`
does not prove its failure behavior and must be identified explicitly in the
validation report.

## Out of scope

- Applying, changing, or repairing any database migration or function.
- Production, Azure, Key Vault, deployment, or environment validation or
  changes.
- Provider behavior changes or external-provider correctness testing.
- Authentication or tenant model redesign.
- Application, test, package, or lockfile changes.
- Committing validation artifacts or source changes.
