# Clean-start Azure runtime preflight (draft; no live access)

This gate checks **the final PostgreSQL security contract**, not only SQL migration
syntax. It is intended to catch a wrong database login, an overly privileged
runtime principal, disabled RLS, accidental direct scan/evidence writes, or a
worker that can execute browser authentication functions. It is deliberately
independent of Supabase data and legacy migration compatibility.

## Executable offline/disposable evidence

- `node scripts/azure-data/test-azure-runtime-preflight.mjs` uses mock catalog
  queries and deliberate privilege/role/RLS mutations. It makes **no** DB,
  network or Azure calls.
- `scripts/azure-data/run-disposable-db.sh` applies migrations 001–009 to a
  temporary PostgreSQL 16 database on 127.0.0.1. After migration 009 it runs
  `node scripts/azure-data/azure-runtime-preflight.mjs --disposable` as the
  actual `cbc_app` and `cbc_worker` roles, using the existing disposable
  one-time credentials. The preflight rejects any non-loopback host, any
  database other than `cbc_test`, or any role name mismatch.
- The preflight executes **SELECT-only catalog and privilege queries**:
  current role attributes and role membership, RLS enabled on 14 tenant and
  security tables, absence of direct protected table writes, worker absence
  of tenant-table reads, and exact EXECUTE privileges for scan creation,
  sign-in, session resolution, lease claim and atomic completion.
  Deprecated separate ACK/mark-processing functions must not be callable.
- Read-only GitHub PR CI runs the mock suite and the disposable integration
  suite. A green result proves only the tested branch's local PostgreSQL
  schema and grants; it does not prove Azure-managed-identity binding.

## Founder-controlled live deployment gate (not executed)

1. Verify the *actual* existing Azure PostgreSQL server/database, resource
   group, Key Vault, Container Apps environment and registry. Record resource
   IDs, not secret values. Do not assume a role name maps to an Entra identity.
2. Confirm the **dedicated** web and worker user-assigned managed identities
   are different, neither inherits the legacy vault-wide identity, and each
   has only its needed Key Vault/ACR scopes. Confirm Entra PostgreSQL
   principals map **web → cbc_app** and **worker → cbc_worker** without
   ownership, admin rights, BYPASSRLS or role membership escalation.
3. On a *new* approved empty database, review and apply the migrations in
   order using an authorized owner, then independently repeat the same
   read-only catalog/privilege checks as the two restricted runtime roles.
   The included executable intentionally cannot connect to a live server;
   live checks require a separate, explicitly approved operator action.
4. Verify Entra External ID issuer, redirect URI, client registration,
   PKCE/code exchange, OIDC state secret/key rotation, cookie domain and
   HTTPS origin. Verify managed-identity PostgreSQL tokens and **verified
   hostname/TLS** for each runtime separately. A successful health endpoint
   does not prove login or database access.
5. Verify the web's `CBC_DATABASE_URL` uses only `cbc_app` and the worker's
   `CBC_WORKER_DATABASE_URL` uses only `cbc_worker`, with no passwords.
   Worker `CBC_WORKER_AZURE_CLIENT_ID` must be different from the web's
   `AZURE_CLIENT_ID`; do not interchange them. Verify the worker has no
   public ingress and cannot access the OIDC state secret.
6. Verify a digest-pinned image and cost-reviewed, explicit provisioning
   flags. The worker's two opt-ins are **not** authorization to incur costs.
   Review Azure what-if, identity role grants, scheduling frequency, provider
   billing and expected rollback before approving any real changes.
7. Only after separately approved provisioning/deployment, test a real
   Entra login, a tenant-isolated URL submission, SSRF denial, outbox claim,
   fake/no-cost scan completion, evidence retrieval, session revocation and
   retry/crash recovery. Keep rollback as an explicit traffic decision, not
   an automatic return to Inngest or Supabase.

## Stop conditions

Do not deploy or cut over if any catalog check fails, if identity-to-role
mapping is unproven, if a worker can directly mutate scan/evidence tables,
if the web can execute worker completion, if tenant RLS is disabled, if TLS
hostname validation is bypassed, or if any real paid-provider invocation is
possible without explicit approval.

This document and the CI tests **do not authorize** Azure access, live SQL,
cloud provisioning, secrets, paid calls, deployments, workflow dispatch,
merges, DNS changes, or retirement of existing services.
