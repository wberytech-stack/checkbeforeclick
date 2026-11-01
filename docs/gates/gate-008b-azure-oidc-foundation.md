# Gate 008B — Azure External ID OIDC security foundation

**Status:** Draft, code-only. No route wiring, live identity calls, credentials, provisioning, database writes or deployment.

**Purpose:** Replace the future Supabase Auth dependency with a secure OIDC authorization-code flow, using Microsoft Entra External ID. Existing Supabase users do **not** need migration (founder decision 2026-11-01). This is independent of Gate 008A's draft Azure data-plane PR #58.

## Changed files

- `src/security/azureOidc.ts`: dependency-free PKCE/state/nonce generator and strict RS256 ID-token verifier, with injected JWKS and clock.
- `scripts/azure-auth/test-oidc.ts`: 49 offline positive/negative tests using locally generated RSA keys.
- `src/security/azureOidcTransport.ts`: server-side trusted-issuer OIDC discovery, JWKS loading and authorization-code token exchange, with injected fetch.
- `scripts/azure-auth/test-transport.ts`: 40 offline transport security tests, all using fake fetch without network access.
- `.github/workflows/azure-oidc-validate.yml`: read-only PR validation for both test suites, with no secrets, deployment or cloud access.
- This gate document.

## Security design

1. Authorization uses only `response_type=code` and `code_challenge_method=S256`; random 256-bit state, nonce and code verifier are independent. Callback state is compared in constant time. The caller must consume state exactly once.
2. Issuer, authorization endpoint and redirect URI must be HTTPS, without credentials, fragments or caller-controlled query parameters. The redirect URI is a fixed `/auth/callback` path.
3. The ID token must be an RS256-signed three-part JWT. `alg=none`, algorithm confusion, critical headers, unknown or duplicate `kid`, weak RSA keys and invalid signature are rejected.
4. `iss` must exactly match the trusted issuer, `aud` the configured client ID, and `azp` the client ID when multiple audiences are present. Nonce and expiry checks are mandatory.
5. Only verified `(issuer, sub)` is the account key. Email and display name are informational, never linking keys. Azure database `app_sign_in` in PR #58 binds that pair to a user.
6. Discovery is built from a **configured, exact Entra issuer**, not from request parameters or JWT `jku`/`x5u`. The metadata issuer must match exactly; authorization, token and JWKS URLs must use HTTPS, the same origin **and the same tenant path**. No redirects, query parameters, userinfo or fragments are allowed.
7. Provider requests use a 5-second abort signal, a 5-minute bounded metadata/JWKS cache, explicit refresh for key rotation, no-store, generic errors, content-type checks and size-limited streamed JSON. Failed fetches are not cached. Token exchange uses POST form encoding with the original PKCE verifier and exact callback URI; a confidential-client JWT assertion is optional and never logged.
8. The returned ID token is **unverified** until `verifyIdToken` checks its signature, issuer, audience, nonce and time. The transport does not create sessions or trust claims. No dependencies or environment settings were changed.

## Still required before login works

- Implement a server-only callback with a one-time, replay-resistant state record; store nonce and PKCE verifier in authenticated encrypted HttpOnly Secure SameSite=Lax short-lived state, clear it on every outcome, and rotate the session.
- Verify the returned ID token with the trusted JWKS, allowing at most one forced refresh for key rotation; never accept an unverified token or a client-supplied identity.
- Implement an approved confidential-client assertion mechanism for Entra's server-side code redemption if the chosen app registration requires one. No app registration or credentials are configured here.
- Integrate `signInWithIdentity` in PR #58 using transaction-local tenant context, issue a secure authenticated session, implement logout/expiry/invalidation and end-to-end negative tests.
- Check actual Entra discovery endpoint compatibility in a separately approved environment before any deployment.

## Verification evidence

Local Node 22.16.0, **offline** (2026-11-01):

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/azure-auth/test-transport.ts
# === Gate 008B trusted OIDC transport: 40 passed, 0 failed ===

tsc --noEmit --target ES2017 --lib esnext,dom --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --strict --types node src/security/azureOidcTransport.ts scripts/azure-auth/test-transport.ts
# exit 0 (local Node type definitions; transport is independently typecheckable without a stub)
```

The earlier 49 OIDC foundation tests and GitHub CI success at commit `2b7d1ce` are separate evidence. CI for the new commits must be inspected independently. No real Entra sign-in, live network, database test, browser test or production build was run for this transport slice. No Azure resource, Supabase account, secret, deployment, migration or paid service was touched.

## Explicitly out of scope

- No Entra tenant/app registration, Azure resources, database, secrets, environment changes, deployments, master merge, staging bootstrap, Supabase migration or paid API calls.
- No claim that the application already authenticates with Azure.

## One-time login-state protection (follow-up implementation)

`src/security/azureAuthState.ts` adds a purpose-bound AES-256-GCM encrypted OIDC login-state
cookie, bound to the exact issuer/client ID. The cookie uses a random 96-bit IV,
authenticated key ID, a five-minute lifetime, and `__Secure-cbc-oidc` with
`Secure; HttpOnly; SameSite=Lax; Path=/auth/callback`. The callback must clear
the cookie with the identical path on *every* outcome. No provider tokens or
application credentials are stored in the cookie.

**Critical:** encryption does **not** make a login state one-time. Issuance must
atomically reserve the SHA-256 digest of the random state in a shared durable
store, and callback must atomically consume the unexpired record. The
`LoginStateStore` interface deliberately has **no in-memory production
implementation**. The PostgreSQL implementation must use a unique digest
constraint and a single atomic `DELETE ... WHERE expires_at > now() RETURNING`
(or equivalent) with a short TTL. A failed reservation or consumption denies
login; the callback must not exchange an authorization code without a successful
consume. Concurrent callbacks must never both succeed. Do not use a process
Map or a non-atomic SELECT-then-DELETE in Azure Container Apps.

The state cookie is not an authenticated application session. Implement session
rotation, logout, expiry/invalidation and the verified Entra callback separately.
Key material is supplied by a server-only caller and is **not** read from any
environment variable by this module; runtime secret configuration remains a
founder-only operation. Maintain a previous decryption key during a bounded
rotation window and never accept unknown key IDs.

### Verification for this follow-up

- Node 22.16.0, offline: `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/azure-auth/test-state.ts` → **29 passed, 0 failed**.
- Standalone strict TypeScript check for the new module/test → exit 0, using
  installed local Node type definitions and a local-only type stub for
  `LoginChallenge` (not committed). This is **not** a full repository typecheck.
- The exact committed Git blob SHAs were independently compared with the tested
  local files: `src/security/azureAuthState.ts` =
  `1b649bf0e6daf0e2a5647d5a67b13eb2837fe84f`;
  `scripts/azure-auth/test-state.ts` =
  `76adddbe47a2fa6f83bbe4a61088a8533632df9b`.
- The PR validation workflow now includes this suite. GitHub CI on the
  new head must be checked independently; no live Entra sign-in, Azure DB,
  production build or browser callback was exercised.
- No secrets, environment, dependency, cloud or database settings changed.


## PostgreSQL-backed replay store adapter (follow-up)

The new server-only module **src/server/auth/postgresLoginStateStore.ts** implements LoginStateStore against the two functions introduced in **Gate 008A draft migration 006**:
- reserve: parameterized call to app_reserve_oidc_login_state, with a SHA-256 digest and expiry seconds;
- consume: parameterized call to app_consume_oidc_login_state, with a digest only. The database clock is authoritative and the caller's nowSeconds is deliberately not passed to SQL.
- The adapter accepts only a canonical lowercase 64-character digest and safe integer timestamps, requires exactly one boolean-true database result, and fails closed with a generic error on query failure. It never logs or returns SQL errors, connection details, state digests or secrets.

**Critical transaction boundary:** the injected query executor must COMMIT each reserve or consume before resolving (e.g., a PostgreSQL pool's autocommit query method, or a dedicated short transaction). Do not wrap state consumption, Entra token exchange and session issuance in a single database transaction: rolling back after an external token exchange would resurrect the replay record. The callback must consume before exchanging a code. This module is not yet wired to a route or a live database.

**Validation:** scripts/azure-auth/test-postgres-state.ts contains 18 offline checks for bound parameters, strict boolean responses, malformed inputs, fail-closed errors, and database-clock authority. The read-only PR CI workflow invokes it with the react-server condition. A separate disposable PostgreSQL suite for migration 006 lives in PR #58. CI results for these new changes must be checked before marking them passed; no Azure resource or real database has been touched.


## Server-side callback sequencing (follow-up)

Added `src/security/azureOidcCallback.ts` (testable orchestration) and `src/server/auth/redeemAzureCallback.ts` (server-only binding to the real `consumeLoginState`, `verifyIdToken`, and pinned `TrustedOidcTransport`). This is **not yet a browser route or authenticated session**.

The callback:
1. Rejects ambiguous provider error/code responses, invalid code characters/length and unsafe callback redirects before any external request.
2. **Atomically consumes the durable login-state record before code exchange**; replay or database failure prevents token exchange.
3. Uses the sealed cookie's PKCE verifier and nonce, and server-configured issuer, audience and redirect; no browser-supplied identity is accepted.
4. Verifies the ID token signature, issuer, audience, nonce and expiry. A signing-key mismatch permits **one** forced JWKS refresh and one final verification; nonce/issuer/audience/time errors never refresh.
5. Returns only a verified identity, never a session or unverified token. Errors are generic and do not expose token, state, provider or database details.

**Actual offline validation:** `node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/azure-auth/test-callback.ts` → **22 passed, 0 failed** on Node 22.16.0. A standalone strict TypeScript check of the two modules and tests returned exit 0 using local temporary type declarations; this is **not** a full repository typecheck. The three new committed file blob hashes were independently compared to the locally tested source. The read-only PR CI now runs the callback suite; verify the new-head CI separately.

**Still needed before a working login:** server-side `/auth/login` and `/auth/callback` routes, always clearing the state cookie on callback success/failure; durable revocable session creation/rotation/logout; `signInWithIdentity` integration with Gate 008A's database; runtime configuration and a separately approved live Entra compatibility test. No production database, Azure resource, secret, deployment, dependency, manual workflow dispatch or master merge was changed.

## Opaque authenticated session credentials (follow-up)

`src/security/azureSession.ts` now provides cryptographically random, 256-bit,
canonical base64url session tokens and a purpose-separated SHA-256 digest for
database lookup. **Only the digest may be persisted**; no claims, identity,
tenant, or expiry are trusted from the browser. Cookies use the host-only
`__Host-cbc-session` prefix, `Path=/`, `Secure`, `HttpOnly`,
`SameSite=Lax`, and a maximum 12-hour browser lifetime. Cookie parsing
rejects duplicates, non-canonical encoding, CRLF, and oversized headers.
Logout cookie deletion uses the same name and path.

**This is not yet an authenticated session.** The token generator is explicitly
named `createUnpersistedAzureSessionToken`. No route may set the cookie
until an Azure PostgreSQL transaction has committed the token digest,
verified identity binding and server-side expiry. Each authenticated request
must check durable expiry and revocation. Rotation must atomically revoke the
old digest and commit the new one before setting the replacement cookie.
On logout, revoke the durable digest and clear the cookie; if revocation
fails, fail closed and never imply that server-side access was revoked.
Use POST plus origin/CSRF protection for logout and other mutations;
SameSite=Lax alone is not a complete CSRF defense.

**Offline validation (2026-11-01):**
`node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/azure-auth/test-session.ts`
→ **34 passed, 0 failed** on local Node 22.16.0. The committed Git blob
SHAs matched the locally tested files: source
`49d95c53f5afd74f04c5116c03f3323fb501d71a`, test
`36a1830c3c8c4c707384a118b5647d71ef19974f`.
The PR's read-only GitHub CI now runs this suite. Full repository TypeScript
and CI for these commits must be checked separately; local standalone
TypeScript validation was not available due to missing Node type definitions.
No database, Entra tenant, Azure resource, secrets, deployment, or paid
API were touched.

**Next implementation:** add draft migration 007 in PR #58 for a
least-privileged, digest-only, expiring/revocable session ledger with
atomic rotation and tenant-safe identity lookup; then implement the
server-only adapter and browser routes in PR #59.


## 2026-11-01 — strict callback HTTP boundary (draft, no route switch)

- Added `src/security/azureCallbackHttp.ts`: framework-neutral `Request` → `Response` handler for the **future** Entra `/auth/callback` route. It accepts only an exact configured HTTPS public origin and pinned issuer, never Host or X-Forwarded-* as redirect authority.
- It rejects duplicate and unknown callback query keys (including percent-encoded aliases), invalid/missing state or code, provider errors, issuer mix-up, malformed or duplicated encrypted login-state cookies, and oversized requests **before** calling `completeAzureLogin`.
- Success emits only the canonical, committed `__Host-cbc-session` cookie returned by `completeAzureLogin`; all paths clear `__Secure-cbc-oidc`, use fixed 303 redirects and private/no-store responses. Invalid configuration returns 503 without redirect.
- Added `scripts/azure-auth/test-callback-http.ts` with **30** offline positive/negative HTTP boundary checks; read-only PR CI runs them via the existing test-only TypeScript resolver. No provider, database or cloud access.
- The local Node 22.16.0 run passed **30/30** with the actual new source/test files and temporary stand-ins for the already-tested `azureAuthState` and `azureSession` primitives. Those stand-ins are **not committed** and are not evidence of a full integration test. Both committed Git blob SHAs match the locally executed new files: source `74cd6b0`, test `562d479`. GitHub CI must validate against the actual repository dependencies.
- **Not yet wired:** the existing `app/auth/callback/route.ts` still handles legacy Supabase callback traffic. Switching it must use a real committed/autocommit Azure PostgreSQL executor from draft PR #58, verified Entra transport and configured keys, and must not reuse the insecure legacy database pool on master. No deployment, secret, live database or identity-provider changes were made.

**Next coding action:** implement the secure server-only Entra runtime binding (issuer/client/origin/key validation, PR #58 verified-TLS/autocommit database pool) and wire the Next.js `/auth/callback` route to this handler, with route-level regression tests. Do not deploy before separate founder approval.
