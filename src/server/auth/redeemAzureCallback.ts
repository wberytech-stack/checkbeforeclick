/**
 * Gate 008B: server-only binding of the tested callback sequence to real
 * cryptographic state redemption and ID-token verification. Browser routes
 * must use this wrapper, not inject their own verification implementation.
 * The caller clears the state cookie on success AND failure and establishes
 * a separately revocable session only after this returns a verified identity.
 */
import "server-only";
import { consumeLoginState, type LoginStateBinding, type LoginStateKeys,
  type LoginStateStore } from "../../security/azureAuthState";
import { verifyIdToken } from "../../security/azureOidc";
import { TrustedOidcTransport } from "../../security/azureOidcTransport";
import { redeemAzureOidcCallback } from "../../security/azureOidcCallback";

export async function redeemAzureCallback(input: {
  code: unknown;
  state: unknown;
  providerError?: unknown;
  cookie: unknown;
  binding: LoginStateBinding;
  redirectUri: string;
  keys: LoginStateKeys;
  store: LoginStateStore;
  transport: TrustedOidcTransport;
  /** Signed only after one-time state consumption; never browser supplied. */
  clientAssertionFactory?: () => string;
}) {
  const { transport, ...callback } = input;
  return redeemAzureOidcCallback({
    ...callback,
    operations: {
      consumeState: consumeLoginState,
      exchangeCode: (args) => transport.exchangeCode({
        ...args, clientAssertion: input.clientAssertionFactory?.(),
      }),
      jwks: (forceRefresh) => transport.jwks(forceRefresh),
      verifyIdToken,
    },
  });
}
