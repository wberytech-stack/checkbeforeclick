# Azure first-scan vertical slice (draft, not deployed)

The standalone `/azure` page deliberately bypasses all legacy Supabase
layouts, accounts, dashboards and Inngest endpoints. It uses the Entra External
ID browser routes and Azure PostgreSQL scan APIs from this draft PR.

## Browser contract

1. Open `/azure` and select **Sign in**. The OIDC callback must return to
   `/azure` with a committed, revocable, HttpOnly session cookie.
2. Submit an HTTP(S) URL. The browser sends only
   `{ "input_type": "url", "raw_input": "https://..." }` to
   `POST /api/azure/scans`. The server checks exact origin, tenant session,
   membership, role and database permissions; it must not trust browser state.
3. On HTTP 201, the browser polls `GET /api/azure/scans/{id}` with
   same-origin credentials and `no-store` caching. It stops at a terminal
   state or after a bounded polling interval. Unauthorized requests display a
   sign-in action; transient errors never invent a verdict.
4. Only React text nodes render URL and evidence. **Do not make submitted URLs
   clickable** or render evidence as HTML. Unknown/absent reputation is
   **not** a safety clearance. Logout uses a same-origin POST to revoke the
   session; GET logout is forbidden.

## Verified disposable HTTP-to-worker-to-UI integration

The draft branch now includes the Azure PostgreSQL migrations 005–009, the
real scan-create/read HTTP handlers, a durable PostgreSQL outbox, a
lease-bound worker, and the browser result parser. The
`scripts/azure-data/validate-first-scan-db.mjs` test uses **real HTTP Request
and Response objects** against those handlers, a real committed PostgreSQL
session, and a disposable PostgreSQL 16 database. It runs the actual
provider-neutral worker with a deterministic fake reputation provider,
then reads the persisted evidence through the authenticated HTTP handler.

On 2026-11-02, **18/18 integration assertions passed** in
[data-plane-validate CI #41423480660](https://github.com/wberytech-stack/checkbeforeclick/actions/runs/41423480660).
The checks cover both `unknown` and `dangerous` verdicts, tenant A/B read
denial, durable outbox completion, no duplicate provider invocation,
provider-outage fail-closed behavior, and revoked session denial.
The tests make **no live Entra, Azure, Supabase or paid provider calls**.

This establishes the application code's disposable-database contract,
**not** a live Azure deployment, real Entra sign-in, external provider
integration, or browser-driven production journey. It does not establish
that the Container Apps Job scheduler or managed-identity database roles
have been provisioned or configured.

## Remaining Azure integration

- Review and reconcile PR #58/#59 overlap before merging; do not blindly
  overlay their schema and PostgreSQL transport files.
- Initialize a **fresh** Azure PostgreSQL application database using
  reviewed migrations 001–009 and separately approved credentials; never
  use the owner/admin role for the web or worker.
- Configure separate non-BYPASSRLS `cbc_app` and `cbc_worker` identities,
  verified TLS, Entra External ID application registration, trusted issuer,
  and protected secrets under founder-approved deployment procedures.
- Configure and test a scheduled Azure Container Apps Job for the durable
  PostgreSQL outbox. A Google Web Risk key is optional but paid provider
  calls require explicit approval; an absent provider must never imply
  a safe verdict.
- Verify the live browser sign-in, scan, evidence, logout, retries, resource
  usage and rollback before switching production traffic.

The web role must not own tables, bypass RLS or write terminal scan results.
The worker role must not read browser sessions or mutate scan/evidence rows
outside the lease-bound completion function.

## Acceptance checks (require an approved disposable Azure environment)

- Unauthenticated POST and scan read return 401; viewer cannot create scans.
- Tenant A cannot read Tenant B's scan ID or evidence.
- A submitted URL produces a pending scan and exactly one durable outbox job
  in the same committed transaction.
- Worker processes an authorized public URL; UI shows a terminal verdict and
  evidence from the same tenant.
- A private/loopback/credentialed URL is rejected by the worker. Provider
  failures never produce a false "safe" verdict.
- Duplicate delivery, expired leases and concurrent workers cannot finalize
  twice or write cross-tenant evidence.
- Logout revokes the browser session; subsequent scan API calls return 401.
- Simulate provider outage, DB outage and scheduler restart; verify bounded
  retries and fail-closed UI. Keep secrets out of logs.
- Review deployment IaC and rollback plan before founder-approved deployment.

No Azure resources, live database writes, secrets or deployments are
performed by this documentation or the offline test suite.
