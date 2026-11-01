/**
 * Azure browser-session boundary for tenant-scoped PostgreSQL operations.
 *
 * The opaque cookie is only a lookup credential. Identity, organization and
 * role MUST come from migration 007's revocation/expiry/membership-checked
 * app_resolve_auth_session() result. A single transaction resolves the session,
 * installs transaction-local tenant GUCs, and executes the protected operation.
 *
 * Never use this with a privileged database role (BYPASSRLS, table owner or
 * superuser); production must connect as the restricted cbc_app role. Callers
 * must await this function before emitting an HTTP response, and must not
 * perform protected reads/writes outside the provided client/transaction.
 */
import "server-only";
import { digestAzureSessionToken, readAzureSessionToken } from "../../security/azureSession";
import {
  createPostgresAuthSessionStore,
  type CommittedSessionQuery,
  type ResolvedAzureSession,
} from "./postgresAuthSessionStore";

const SET_TENANT_SQL =
  "SELECT set_config('app.current_user_id', $1, true) AS user_id, " +
  "set_config('app.current_organization_id', $2, true) AS organization_id";

export type AzureTenantSessionDependencies = {
  /** BEGIN/COMMIT on one client, rollback on failure; resolves only after COMMIT. */
  transaction<T>(fn: (client: CommittedSessionQuery) => Promise<T>): Promise<T>;
};

export type AzureTenantSessionResult<T> =
  | { authenticated: false }
  | { authenticated: true; value: T };

export class AzureTenantSessionUnavailable extends Error {
  constructor() {
    super("Azure tenant session unavailable");
    this.name = "AzureTenantSessionUnavailable";
  }
}

/**
 * Resolves an Azure browser session and executes one tenant-protected DB
 * operation. Missing, malformed, expired or revoked sessions are denied.
 * Storage, transaction and protected-operation errors fail closed with a
 * sanitized error (the HTTP caller should return a no-store 503).
 *
 * The callback receives the SAME transaction client with tenant context set,
 * and a frozen, DB-derived identity. No browser-supplied organization/role
 * or request headers can select a tenant. The callback MUST NOT emit cookies,
 * perform network calls or return a response before transaction commit.
 */
export async function withAzureTenantSession<T>(
  cookieHeader: unknown,
  deps: AzureTenantSessionDependencies,
  operation: (client: CommittedSessionQuery, session: Readonly<ResolvedAzureSession>) => Promise<T>,
): Promise<AzureTenantSessionResult<T>> {
  const token = readAzureSessionToken(cookieHeader);
  const digest = digestAzureSessionToken(token);
  if (!digest) return { authenticated: false };

  try {
    return await deps.transaction(async (client) => {
      const session = await createPostgresAuthSessionStore(client).resolve(digest);
      if (!session) return { authenticated: false };
      // The database alone determines the two IDs. 'true' is essential:
      // GUCs must disappear at transaction end, not leak to the next user.
      const configured = await client.query(SET_TENANT_SQL, [
        session.userId, session.organizationId,
      ]);
      if (configured.rows.length !== 1 ||
          configured.rows[0]?.user_id !== session.userId ||
          configured.rows[0]?.organization_id !== session.organizationId) {
        throw new AzureTenantSessionUnavailable();
      }
      const value = await operation(client, Object.freeze({ ...session }));
      return { authenticated: true, value };
    });
  } catch {
    // Never surface SQL text, digests, cookie values or driver credentials.
    throw new AzureTenantSessionUnavailable();
  }
}
