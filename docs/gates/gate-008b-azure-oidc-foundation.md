# Gate 008B — Azure External ID OIDC security foundation

**Status:** Draft, code-only. No route wiring, live identity calls, credentials, provisioning, database writes or deployment.

**Purpose:** Replace the future Supabase Auth dependency with a secure OIDC authorization-code flow, using Microsoft Entra External ID. This gate implements and tests the pure cryptographic and protocol primitives only. Existing Supabase users do **not** need migration (founder decision 2026-11-01). This is independent of Gate 008A's draft Azure data-plane PR #58 and can be reviewed without changing it.

## Changed files

- `src/security/azureOidc.ts`: dependency-free PKCE/state/nonce generator and strict RS256 ID-token verifier, with injected JWKS and clock.
- `scripts/azure-auth/test-oidc.ts`: offline positive/negative tests using locally generated RSA keys; no external identity provider.
- `.github/workflows/azure-oidc-validate.yml`: read-only pull-request validation with no secrets, deployment or cloud access.
- This gate document.

## Security design

1. Authorization uses only `response_type=code` and `code_challenge_method=S256`; random 256-bit state, nonce and code verifier are independent. Callback state is compared in constant time. The caller must consume the state exactly once.
2. Issuer, authorization endpoint and redirect URI must be HTTPS, without credentials, fragments or caller-controlled query parameters. The authorization endpoint shares the issuer's origin; the redirect URI is a fixed `/auth/callback` path.
3. The ID token must be an RS256-signed three-part JWT. `alg=none`, algorithm confusion, critical headers, unknown or duplicate `kid`, weak RSA keys and invalid signature are rejected. JWK must be a signing/verification key.
4. `iss` must exactly match the configured trusted issuer, `aud` the configured client ID, and `azp` the client ID when multiple audiences are present. Nonce is required and compared in constant time. `exp`, `iat`, optional `nbf` and a two-hour maximum token lifetime are checked with at most 60 seconds of skew.
5. Only the verified `(issuer, sub)` pair is the account key. Email and display name are optional informational claims, never account-linking keys. The future Azure database `app_sign_in` in PR #58 binds that pair to a user.
6. Token/JWK parsing has size limits; errors are generic and do not echo the token or login secrets. No dependency or environment change is introduced.

## Required server-side integration in the next 008B slice (NOT yet implemented)

- Fetch and pin OIDC metadata and JWKS **only** from the allow-listed Entra issuer over HTTPS, with bounded caching, key-rotation handling and timeouts. Never trust a token-supplied `jku`/`x5u` or redirect.
- Exchange the authorization code server-side at the trusted token endpoint with the original PKCE verifier and exact redirect URI. Validate token `nonce` against the browser's one-time state.
- Store state, nonce and verifier in an authenticated, encrypted, HttpOnly, Secure, SameSite=Lax, short-lived cookie; clear on success, failure and expiry; prevent replay. Implement CSRF defenses and session rotation at sign-in.
- Issue an authenticated encrypted session cookie after `signInWithIdentity` from PR #58 returns an account. Do not accept user/org IDs from request bodies or URL parameters. All Azure DB queries use transaction-local tenant context.
- Provide logout/session expiry, session invalidation and negative integration tests. Do not switch production auth before end-to-end verification.

## Verification

Local commands (Node 22.16.0):

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/azure-auth/test-oidc.ts
# === Gate 008B OIDC foundation: 49 passed, 0 failed ===

tsc --noEmit --target ES2017 --lib esnext,dom --module esnext --moduleResolution bundler --allowImportingTsExtensions --skipLibCheck --strict --types node --typeRoots <local-node-types> src/security/azureOidc.ts scripts/azure-auth/test-oidc.ts
# exit 0
```

These are **offline unit tests**, not an Entra sign-in, browser test, production build or end-to-end validation. GitHub Actions result must be checked separately after the PR is opened. No cloud resource or Supabase account was touched.

## Explicitly out of scope

- No Entra tenant or app registration changes; no Azure resource, database, secret, or environment changes.
- No deployment, master merge, staging bootstrap, Supabase migration, or paid API calls.
- No claim that the application already authenticates with Azure.
