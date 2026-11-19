/**
 * Gate 008B: trusted callback -> identity provisioning -> committed session.
 *
 * No cookie is issued until the one-time OIDC state has been consumed, the ID
 * token has been verified, and PostgreSQL session creation has COMMITTED.
 * Only pass server-configured OIDC binding, keys, stores and transport here;
 * browser input is limited to code/state/providerError/cookie.
 *
 * The caller MUST append every returned Set-Cookie header, including failures.
 * Returning a failure instead of throwing ensures the state cookie is cleared
 * even when the provider or database is unavailable. Never log raw cookies.
 */
import "server-only";
import { loginStateClearCookie } from "../../security/azureAuthState";
import { AZURE_SESSION_TTL_SECONDS, azureSessionSetCookie,
  createUnpersistedAzureSessionToken } from "../../security/azureSession";
import { redeemAzureCallback } from "./redeemAzureCallback";
import type { ProvisionedAzureIdentity } from "./postgresIdentityProvisioner";
import type { PostgresAuthSessionStore } from "./postgresAuthSessionStore";
import type { VerifiedOidcIdentity } from "../../security/azureOidc";

export type AzureLoginCompletion =
  | { ok: true; setCookies: readonly [string, string] }
  | { ok: false; setCookies: readonly [string] };

export async function completeAzureLogin(input: {
  callback: Parameters<typeof redeemAzureCallback>[0];
  /** Must use the committed, autocommit app_sign_in database adapter. */
  provisioner: { provision(identity: VerifiedOidcIdentity): Promise<ProvisionedAzureIdentity | null> };
  /** Must use the committed, autocommit app_create_auth_session adapter. */
  sessions: Pick<PostgresAuthSessionStore, "create">;
}): Promise<AzureLoginCompletion> {
  const clear = loginStateClearCookie();
  try {
    // This is the ONLY path from untrusted callback fields to an identity.
    const identity = await redeemAzureCallback(input.callback);
    const provisioned = await input.provisioner.provision(identity);
    if (!provisioned) return { ok: false, setCookies: [clear] };

    const { token, digest } = createUnpersistedAzureSessionToken();
    const expiry = Math.floor(Date.now() / 1000) + AZURE_SESSION_TTL_SECONDS;
    if (!Number.isSafeInteger(expiry) ||
        !await input.sessions.create(identity, digest, expiry)) {
      return { ok: false, setCookies: [clear] };
    }
    // Session creation must have committed before this credential is exposed.
    return { ok: true, setCookies: [clear, azureSessionSetCookie(token)] };
  } catch {
    // Fail closed without leaking provider, SQL, token or personal data.
    return { ok: false, setCookies: [clear] };
  }
}
