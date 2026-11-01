/**
 * Gate 008B: fail-closed OIDC callback sequence, independent of Next.js routes.
 *
 * This does not establish an application session. The server route must clear the
 * login-state cookie on EVERY outcome, then persist the verified identity and
 * issue a separately revocable, rotated session. Never send an unverified token
 * or a browser-supplied identity to the database.
 */
import type { LoginStateBinding, LoginStateKeys, LoginStateStore, RedeemedLoginState } from "./azureAuthState";
import type { VerifiedOidcIdentity, RsaJwk } from "./azureOidc";

export class AzureOidcCallbackError extends Error {
  constructor() { super("Authentication could not be completed"); this.name = "AzureOidcCallbackError"; }
}

type TokenInput = {
  token: string;
  jwks: { keys: RsaJwk[] };
  issuer: string;
  audience: string;
  nonce: string;
};

/** Dependencies are supplied by the server-only route; no browser input selects them. */
export type AzureOidcCallbackOperations = {
  consumeState(input: {
    cookie: unknown;
    callbackState: unknown;
    binding: LoginStateBinding;
    keys: LoginStateKeys;
    store: LoginStateStore;
  }): Promise<RedeemedLoginState>;
  exchangeCode(input: { code: string; codeVerifier: string; clientId: string; redirectUri: string }): Promise<string>;
  jwks(forceRefresh?: boolean): Promise<{ keys: RsaJwk[] }>;
  verifyIdToken(input: TokenInput): VerifiedOidcIdentity;
};

/**
 * One-way callback flow: consume state durably -> exchange code -> verify ID
 * token. A failed or replayed state never reaches the identity provider.
 * Caller MUST clear the login-state cookie even when this function rejects.
 */
export async function redeemAzureOidcCallback(input: {
  code: unknown;
  state: unknown;
  providerError?: unknown;
  cookie: unknown;
  binding: LoginStateBinding;
  redirectUri: string;
  keys: LoginStateKeys;
  store: LoginStateStore;
  operations: AzureOidcCallbackOperations;
}): Promise<VerifiedOidcIdentity> {
  try {
    // The provider may return error instead of code. Never redeem on ambiguity.
    if (input.providerError !== undefined || typeof input.code !== "string" ||
        !/^[\x21-\x7e]{1,4096}$/.test(input.code)) throw new Error("invalid callback");
    const redirect = new URL(input.redirectUri);
    if (redirect.protocol !== "https:" || !redirect.hostname || redirect.username || redirect.password ||
        redirect.hash || redirect.search || redirect.href !== input.redirectUri ||
        !redirect.pathname.endsWith("/auth/callback")) throw new Error("invalid redirect");

    // Must commit the atomic state consumption BEFORE any external code exchange.
    const { nonce, codeVerifier } = await input.operations.consumeState({
      cookie: input.cookie, callbackState: input.state, binding: input.binding,
      keys: input.keys, store: input.store,
    });
    const token = await input.operations.exchangeCode({
      code: input.code, codeVerifier, clientId: input.binding.clientId,
      redirectUri: input.redirectUri,
    });
    let jwks = await input.operations.jwks();
    const verify = () => input.operations.verifyIdToken({
      token, jwks, issuer: input.binding.issuer,
      audience: input.binding.clientId, nonce,
    });
    try { return verify(); }
    catch (error) {
      // Exactly one key-rotation retry, and only for signing-key failures.
      // All issuer/audience/nonce/time/claims failures are terminal.
      if (!(error instanceof Error) ||
          (error.message !== "OIDC signing key must be unique and present" &&
           error.message !== "OIDC signature invalid")) throw error;
      jwks = await input.operations.jwks(true);
      return verify();
    }
  } catch {
    // No authorization code, token, cookie, SQL detail or provider error leaks.
    throw new AzureOidcCallbackError();
  }
}
