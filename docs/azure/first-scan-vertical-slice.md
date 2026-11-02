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

## Critical integration dependency

This branch contains scan-create and scan-read APIs, **not** the complete
job processing pipeline. Before claiming an end-to-end scan is functional,
integrate and regression-test the durable outbox, lease-bound completion and
Azure worker from draft PR #58. PR #58 and #59 both touch the PostgreSQL
transport and schema, so review conflicts instead of blindly overlaying files.

The application must run the required fresh PostgreSQL migrations in order
using separately approved migration credentials. The web role must not own
tables, bypass RLS or write terminal scan results. The worker role must not
read browser sessions or mutate scan/evidence rows outside the lease-bound
completion function.

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
