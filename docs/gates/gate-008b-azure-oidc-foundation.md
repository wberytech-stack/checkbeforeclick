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
# exit 0 (local Node type definitions; pre-existing azureOidc.ts was represented by a test-only matching type/error stub)
```

The earlier 49 OIDC foundation tests and GitHub CI success at commit `2b7d1ce` are separate evidence. CI for the new commits must be inspected independently. No real Entra sign-in, live network, database test, browser test or production build was run for this transport slice. No Azure resource, Supabase account, secret, deployment, migration or paid service was touched.

## Explicitly out of scope

- No Entra tenant/app registration, Azure resources, database, secrets, environment changes, deployments, master merge, staging bootstrap, Supabase migration or paid API calls.
- No claim that the application already authenticates with Azure.
