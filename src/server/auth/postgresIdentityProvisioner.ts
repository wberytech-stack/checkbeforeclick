/**
 * Gate 008B: first-login identity provisioning for a fresh Azure database.
 *
 * Only call with an identity returned by the verified Entra OIDC callback.
 * This adapter never accepts a caller-supplied user ID, tenant ID, or role.
 * app_sign_in (migration 005) owns the atomic find-or-provision transaction,
 * trusted-issuer allow-list, membership check, and audit event.
 *
 * The injected query executor MUST commit before resolving. In particular,
 * do not hold a transaction open across the Entra code exchange or response.
 */
import "server-only";
import type { VerifiedOidcIdentity } from "../../security/azureOidc";

export type CommittedIdentityQuery = {
  query(sql: string, values: unknown[]): Promise<{
    rows: ReadonlyArray<Record<string, unknown>>;
  }>;
};

export type ProvisionedAzureIdentity = {
  userId: string;
  organizationId: string;
  role: string;
  created: boolean;
};

const SQL = "SELECT o_user_id, o_organization_id, o_role, o_created FROM public.app_sign_in($1,$2,$3,$4)";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROLE = /^[a-z][a-z0-9_]{0,31}$/;

function validIdentity(value: unknown): value is VerifiedOidcIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Partial<VerifiedOidcIdentity>;
  if (typeof identity.issuer !== "string" || identity.issuer.length > 512 ||
      typeof identity.subject !== "string" || identity.subject.length < 1 ||
      identity.subject.length > 255 || /[\x00-\x1f\x7f]/.test(identity.subject) ||
      (identity.email !== null && (typeof identity.email !== "string" ||
        identity.email.length > 320 || /[\x00-\x1f\x7f]/.test(identity.email))) ||
      (identity.displayName !== null && (typeof identity.displayName !== "string" ||
        identity.displayName.length > 200 || /[\x00-\x1f\x7f]/.test(identity.displayName)))) return false;
  try {
    const url = new URL(identity.issuer);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password &&
      !url.search && !url.hash && url.href === identity.issuer;
  } catch { return false; }
}

function unavailable(): Error {
  // Never propagate driver errors, SQL, issuer, subject or personal data.
  return new Error("Azure identity provisioning unavailable");
}

/**
 * Requires an autocommit cbc_app connection with NO tenant context.
 * Provisioning is idempotent for the same verified issuer+subject.
 * A failed membership lookup is an authentication denial, never a fallback
 * to an email-matched account or an application-selected organization.
 */
export function createPostgresIdentityProvisioner(query: CommittedIdentityQuery) {
  if (!query || typeof query.query !== "function") throw unavailable();
  return {
    async provision(identity: VerifiedOidcIdentity): Promise<ProvisionedAzureIdentity | null> {
      if (!validIdentity(identity)) return null;
      try {
        const result = await query.query(SQL, [
          identity.issuer, identity.subject, identity.email, identity.displayName,
        ]);
        if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) throw unavailable();
        const row = result.rows[0];
        if (!row || typeof row.o_user_id !== "string" || !UUID.test(row.o_user_id) ||
            typeof row.o_organization_id !== "string" || !UUID.test(row.o_organization_id) ||
            typeof row.o_role !== "string" || !ROLE.test(row.o_role) ||
            typeof row.o_created !== "boolean") throw unavailable();
        return {
          userId: row.o_user_id, organizationId: row.o_organization_id,
          role: row.o_role, created: row.o_created,
        };
      } catch { throw unavailable(); }
    },
  };
}
