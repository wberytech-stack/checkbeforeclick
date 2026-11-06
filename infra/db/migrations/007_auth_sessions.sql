-- Gate 008A/008B migration 007: durable, revocable Azure browser sessions.
-- DRAFT: apply only to disposable PostgreSQL until separately approved.
-- Requires 001-006, cbc_app NOSUPERUSER NOBYPASSRLS, and verified OIDC
-- issuer/subject binding from migration 005. Existing Supabase users are not migrated.
-- Only store SHA-256 purpose-separated token digests; never store raw cookies.
BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'cbc_app'
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION '007: cbc_app must be least-privileged and NOBYPASSRLS';
  END IF;
END;
$guard$;

CREATE TABLE public.auth_sessions (
  token_digest text PRIMARY KEY
    CONSTRAINT auth_sessions_digest_format CHECK (token_digest ~ '^[0-9a-f]{64}$'),
  identity_id uuid NOT NULL REFERENCES public.user_identities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CONSTRAINT auth_sessions_expiry_order CHECK (expires_at > created_at),
  CONSTRAINT auth_sessions_revocation_order CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX auth_sessions_identity_idx ON public.auth_sessions (identity_id);
CREATE INDEX auth_sessions_expiry_idx ON public.auth_sessions (expires_at);
ALTER TABLE public.auth_sessions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.auth_sessions FROM PUBLIC, cbc_app;
-- Deliberately no RLS policy. Runtime access is via narrow SECURITY DEFINER functions.

-- Called ONLY after verifying an Entra ID token's signature, issuer, audience,
-- nonce and expiry. The database derives the user/tenant from the trusted
-- issuer+subject identity, never from caller-supplied user or tenant IDs.
CREATE FUNCTION public.app_create_auth_session(
  p_issuer text, p_subject text, p_digest text, p_expires_at_seconds bigint
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_epoch bigint := pg_catalog.floor(EXTRACT(EPOCH FROM v_now))::bigint;
  v_identity uuid;
  v_user uuid;
  v_org uuid;
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$'
     OR p_expires_at_seconds IS NULL OR p_expires_at_seconds <= v_epoch
     OR p_expires_at_seconds > v_epoch + 43260 THEN
    RAISE EXCEPTION 'invalid session credential or expiry' USING ERRCODE = '22023';
  END IF;
  IF p_issuer IS NULL OR p_subject IS NULL THEN
    RETURN false;
  END IF;
  SELECT i.id, i.user_id, u.organization_id INTO v_identity, v_user, v_org
  FROM public.user_identities i
  JOIN public.trusted_identity_issuers t ON t.issuer = i.issuer
  JOIN public.users u ON u.id = i.user_id
  JOIN public.memberships m ON m.user_id = u.id AND m.organization_id = u.organization_id
  WHERE i.issuer = p_issuer AND i.subject = p_subject;
  IF v_identity IS NULL THEN RETURN false; END IF;

  INSERT INTO public.auth_sessions (token_digest, identity_id, user_id, organization_id, expires_at)
  VALUES (p_digest, v_identity, v_user, v_org, pg_catalog.to_timestamp(p_expires_at_seconds))
  ON CONFLICT (token_digest) DO NOTHING;
  RETURN FOUND;
END;
$function$;

-- Re-check membership on every request; a removed member loses access even if
-- their cookie has not expired. Never use this result without tenant-bound
-- transactions for subsequent data access.
CREATE FUNCTION public.app_resolve_auth_session(p_digest text)
RETURNS TABLE (o_user_id uuid, o_organization_id uuid, o_role text)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  RETURN QUERY
  SELECT s.user_id, s.organization_id, m.role
  FROM public.auth_sessions s
  JOIN public.user_identities i ON i.id = s.identity_id AND i.user_id = s.user_id
  JOIN public.users u ON u.id = s.user_id AND u.organization_id = s.organization_id
  JOIN public.memberships m ON m.user_id = s.user_id AND m.organization_id = s.organization_id
  WHERE s.token_digest = p_digest AND s.revoked_at IS NULL
    AND s.expires_at > pg_catalog.clock_timestamp();
END;
$function$;

-- Rotation is a single transaction: lock the old row, revoke it, and insert
-- the replacement. The new credential inherits the ORIGINAL expiry (rotation
-- cannot silently extend the authenticated lifetime). A collision raises and
-- rolls back the revocation; a replay or expired old token returns false.
CREATE FUNCTION public.app_rotate_auth_session(p_old_digest text, p_new_digest text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_old public.auth_sessions%ROWTYPE;
BEGIN
  IF p_old_digest IS NULL OR p_old_digest !~ '^[0-9a-f]{64}$'
     OR p_new_digest IS NULL OR p_new_digest !~ '^[0-9a-f]{64}$'
     OR p_old_digest = p_new_digest THEN
    RAISE EXCEPTION 'invalid session rotation' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_old FROM public.auth_sessions
  WHERE token_digest = p_old_digest FOR UPDATE;
  IF NOT FOUND OR v_old.revoked_at IS NOT NULL
     OR v_old.expires_at <= pg_catalog.clock_timestamp() THEN RETURN false; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.user_identities i
    JOIN public.users u ON u.id = i.user_id
    JOIN public.memberships m ON m.user_id = u.id AND m.organization_id = u.organization_id
    WHERE i.id = v_old.identity_id AND i.user_id = v_old.user_id
      AND u.organization_id = v_old.organization_id
  ) THEN RETURN false; END IF;

  UPDATE public.auth_sessions SET revoked_at = pg_catalog.clock_timestamp()
  WHERE token_digest = p_old_digest;
  INSERT INTO public.auth_sessions (token_digest, identity_id, user_id, organization_id, expires_at)
  VALUES (p_new_digest, v_old.identity_id, v_old.user_id, v_old.organization_id, v_old.expires_at);
  RETURN true;
END;
$function$;

-- Logout/revocation is idempotent and does not reveal whether a digest exists.
CREATE FUNCTION public.app_revoke_auth_session(p_digest text)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
BEGIN
  IF p_digest IS NULL OR p_digest !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
  UPDATE public.auth_sessions SET revoked_at = pg_catalog.clock_timestamp()
  WHERE token_digest = p_digest AND revoked_at IS NULL;
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.app_create_auth_session(text,text,text,bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_resolve_auth_session(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_rotate_auth_session(text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.app_revoke_auth_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_create_auth_session(text,text,text,bigint) TO cbc_app;
GRANT EXECUTE ON FUNCTION public.app_resolve_auth_session(text) TO cbc_app;
GRANT EXECUTE ON FUNCTION public.app_rotate_auth_session(text,text) TO cbc_app;
GRANT EXECUTE ON FUNCTION public.app_revoke_auth_session(text) TO cbc_app;
COMMIT;
