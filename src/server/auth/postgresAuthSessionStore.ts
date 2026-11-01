/**
 * Gate 008B: durable Azure authentication session adapter for migration 007.
 *
 * The caller must supply an AUTOCOMMIT query executor for the cbc_app role.
 * In particular, a successful create/rotate result must mean the database
 * statement has COMMITTED before any Set-Cookie header is emitted. Never
 * share an uncommitted transaction with an HTTP response or provider call.
 *
 * Only SHA-256 purpose-separated digests reach SQL, never raw cookie tokens.
 * The database derives the user, organization and role from a verified
 * issuer+subject and rechecks membership on every resolve/rotation.
 */
import "server-only";
import type { VerifiedOidcIdentity } from "../../security/azureOidc";

export type CommittedSessionQuery = {
  query(sql: string, values: unknown[]): Promise<{
    rows: ReadonlyArray<Record<string, unknown>>;
  }>;
};

export type ResolvedAzureSession = {
  userId: string;
  organizationId: string;
  role: string;
};

export type PostgresAuthSessionStore = {
  create(identity: VerifiedOidcIdentity, digest: string, expiresAtSeconds: number): Promise<boolean>;
  resolve(digest: string): Promise<ResolvedAzureSession | null>;
  rotate(oldDigest: string, newDigest: string): Promise<boolean>;
  revoke(digest: string): Promise<boolean>;
};

const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE = /^[a-z][a-z0-9_]{0,31}$/;
const CREATE_SQL = "SELECT public.app_create_auth_session($1,$2,$3,$4::bigint) AS ok";
const RESOLVE_SQL = "SELECT o_user_id, o_organization_id, o_role FROM public.app_resolve_auth_session($1)";
const ROTATE_SQL = "SELECT public.app_rotate_auth_session($1,$2) AS ok";
const REVOKE_SQL = "SELECT public.app_revoke_auth_session($1) AS ok";

function validDigest(value: unknown): value is string {
  return typeof value === "string" && DIGEST.test(value);
}
function validIdentity(value: unknown): value is VerifiedOidcIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<VerifiedOidcIdentity>;
  if (typeof identity.issuer !== "string" || identity.issuer.length > 512 ||
      typeof identity.subject !== "string" || identity.subject.length < 1 ||
      identity.subject.length > 255 || /[\x00-\x1f\x7f]/.test(identity.subject)) return false;
  try {
    const url = new URL(identity.issuer);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password &&
      !url.search && !url.hash && url.href === identity.issuer;
  } catch { return false; }
}
function validExpiry(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function storageError(): Error {
  // No SQL, issuer, token digest, connection string or driver error in responses.
  return new Error("Azure authentication session storage unavailable");
}

export function createPostgresAuthSessionStore(query: CommittedSessionQuery): PostgresAuthSessionStore {
  if (!query || typeof query.query !== "function") throw storageError();
  async function oneBoolean(sql: string, values: unknown[]): Promise<boolean> {
    try {
      const result = await query.query(sql, values);
      return result.rows.length === 1 && result.rows[0]?.ok === true;
    } catch { throw storageError(); }
  }
  return {
    async create(identity, digest, expiresAtSeconds) {
      if (!validIdentity(identity) || !validDigest(digest) || !validExpiry(expiresAtSeconds)) return false;
      // The identity must come from verified ID-token claims, never browser input.
      return oneBoolean(CREATE_SQL, [identity.issuer, identity.subject, digest, expiresAtSeconds]);
    },
    async resolve(digest) {
      if (!validDigest(digest)) return null;
      try {
        const result = await query.query(RESOLVE_SQL, [digest]);
        if (result.rows.length === 0) return null;
        if (result.rows.length !== 1) throw storageError();
        const row = result.rows[0];
        if (!row || typeof row.o_user_id !== "string" || !UUID.test(row.o_user_id) ||
            typeof row.o_organization_id !== "string" || !UUID.test(row.o_organization_id) ||
            typeof row.o_role !== "string" || !ROLE.test(row.o_role)) throw storageError();
        return { userId: row.o_user_id, organizationId: row.o_organization_id, role: row.o_role };
      } catch { throw storageError(); }
    },
    async rotate(oldDigest, newDigest) {
      if (!validDigest(oldDigest) || !validDigest(newDigest) || oldDigest === newDigest) return false;
      return oneBoolean(ROTATE_SQL, [oldDigest, newDigest]);
    },
    async revoke(digest) {
      if (!validDigest(digest)) return false;
      return oneBoolean(REVOKE_SQL, [digest]);
    },
  };
}
