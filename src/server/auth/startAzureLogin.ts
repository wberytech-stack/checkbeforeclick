/**
 * Server-only Entra login initiation. The durable state reservation must
 * commit before a Set-Cookie or redirect is returned to the browser.
 * Metadata is obtained only through the issuer-pinned transport.
 */
import "server-only";
import { createLoginChallenge } from "../../security/azureOidc";
import { issueLoginState, loginStateSetCookie,
  type LoginStateBinding, type LoginStateKeys, type LoginStateStore } from "../../security/azureAuthState";
import type { TrustedOidcTransport } from "../../security/azureOidcTransport";
import type { AzureLoginStartResult } from "../../security/azureLoginStartHttp";

export async function startAzureLogin(input: {
  publicOrigin: string;
  binding: LoginStateBinding;
  keys: LoginStateKeys;
  store: LoginStateStore;
  transport: Pick<TrustedOidcTransport, "metadata">;
}): Promise<AzureLoginStartResult> {
  try {
    const origin = new URL(input.publicOrigin);
    if (origin.protocol !== "https:" || origin.origin !== input.publicOrigin ||
        origin.username || origin.password || origin.search || origin.hash) throw new Error("invalid origin");
    const metadata = await input.transport.metadata();
    if (metadata.issuer !== input.binding.issuer) throw new Error("issuer mismatch");
    const issuer = new URL(input.binding.issuer);
    if (issuer.protocol !== "https:" || issuer.href !== input.binding.issuer ||
        !issuer.pathname.endsWith("/v2.0") || issuer.pathname === "/v2.0") throw new Error("invalid issuer");
    const expected = issuer.origin + issuer.pathname.slice(0, -"/v2.0".length) + "/oauth2/v2.0/authorize";
    if (metadata.authorizationEndpoint !== expected) throw new Error("untrusted authorization endpoint");
    const challenge = createLoginChallenge({
      issuer: input.binding.issuer,
      clientId: input.binding.clientId,
      authorizationEndpoint: metadata.authorizationEndpoint,
      redirectUri: `${input.publicOrigin}/auth/callback`,
    });
    const sealed = await issueLoginState({
      challenge, binding: input.binding, keys: input.keys, store: input.store,
    });
    return { authorizationUrl: challenge.authorizationUrl, setCookie: loginStateSetCookie(sealed) };
  } catch {
    // Never expose Entra metadata, state, PKCE verifier, encryption keys or SQL.
    throw new Error("Azure login initiation unavailable");
  }
}
