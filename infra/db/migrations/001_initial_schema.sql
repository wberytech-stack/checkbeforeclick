-- CheckBeforeClick Azure PostgreSQL baseline schema
-- Source: audit/database/export/20260605T232800Z-schema.sql
-- Curated for Azure PostgreSQL Flexible Server.
--
-- Deliberately excluded:
-- - managed identity schema dependencies
-- - provider-specific session helper functions
-- - provider-specific secret extension
-- - provider-specific live publication ownership
-- - provider-specific web role permissions
-- - provider-specific RLS policies
-- - ownership override statements
--
-- Important:
-- users.id no longer references a provider-managed identity table.
-- Azure identity integration will be handled by the application/auth layer.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.generate_org_slug(org_name text, user_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  base_slug text;
  suffix    text;
  candidate text;
  counter   int := 0;
BEGIN
  base_slug := lower(trim(org_name));
  base_slug := regexp_replace(base_slug, '[^a-z0-9]+', '-', 'g');
  base_slug := regexp_replace(base_slug, '^-+|-+$', '', 'g');
  base_slug := left(base_slug, 40);

  IF base_slug = '' OR base_slug IS NULL THEN
    base_slug := 'workspace';
  END IF;

  suffix    := lower(left(replace(user_id::text, '-', ''), 6));
  candidate := base_slug || '-' || suffix;

  WHILE EXISTS (
    SELECT 1
    FROM public.organizations
    WHERE slug = candidate
  ) LOOP
    counter   := counter + 1;
    candidate := base_slug || '-' || suffix || '-' || counter::text;

    IF counter > 10 THEN
      candidate := 'workspace-' || lower(left(replace(gen_random_uuid()::text, '-', ''), 10));
      EXIT;
    END IF;
  END LOOP;

  RETURN candidate;
END;
$$;

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    plan text DEFAULT 'free'::text NOT NULL,
    scan_count_this_month integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT organizations_plan_check CHECK (plan = ANY (ARRAY['free'::text, 'pro'::text, 'team'::text, 'msp'::text]))
);

CREATE TABLE public.users (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    full_name text DEFAULT ''::text NOT NULL,
    role text DEFAULT 'member'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT users_role_check CHECK (role = ANY (ARRAY['admin'::text, 'member'::text]))
);

CREATE TABLE public.scans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid,
    input_type text NOT NULL,
    raw_input text NOT NULL,
    email_parsed_data jsonb,
    extracted_indicators jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    risk_score integer,
    confidence_score integer,
    verdict text,
    ai_explanation text,
    recommended_action text,
    scan_duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT scans_confidence_score_check CHECK (confidence_score >= 0 AND confidence_score <= 100),
    CONSTRAINT scans_input_type_check CHECK (input_type = ANY (ARRAY['url'::text, 'domain'::text, 'email'::text, 'header'::text, 'signature'::text, 'batch'::text])),
    CONSTRAINT scans_risk_score_check CHECK (risk_score >= 0 AND risk_score <= 100),
    CONSTRAINT scans_status_check CHECK (status = ANY (ARRAY['pending'::text, 'processing'::text, 'complete'::text, 'failed'::text])),
    CONSTRAINT scans_verdict_check CHECK (verdict = ANY (ARRAY['safe'::text, 'suspicious'::text, 'dangerous'::text, 'unknown'::text]))
);

CREATE TABLE public.scan_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cache_key text NOT NULL,
    vendor_name text NOT NULL,
    result jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.vendor_results (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    vendor_name text NOT NULL,
    verdict text,
    raw_response jsonb,
    error_message text,
    response_time_ms integer,
    checked_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.evidence_items (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    signal_type text NOT NULL,
    severity text NOT NULL,
    title text NOT NULL,
    detail text,
    score_impact integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT evidence_items_severity_check CHECK (severity = ANY (ARRAY['critical'::text, 'high'::text, 'medium'::text, 'low'::text, 'info'::text, 'good'::text]))
);

CREATE TABLE public.scan_feedback (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    scan_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid,
    feedback_type text NOT NULL,
    comment text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scan_feedback_feedback_type_check CHECK (feedback_type = ANY (ARRAY['correct'::text, 'false_positive'::text, 'false_negative'::text, 'uncertain'::text]))
);

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid,
    user_id uuid,
    action text NOT NULL,
    target_type text,
    target_id uuid,
    metadata jsonb,
    ip_address text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.watchlist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    user_id uuid,
    indicator text NOT NULL,
    indicator_type text NOT NULL,
    last_verdict text,
    last_scan_id uuid,
    last_scanned_at timestamp with time zone,
    alert_on_change boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT watchlist_indicator_type_check CHECK (indicator_type = ANY (ARRAY['url'::text, 'domain'::text, 'email'::text])),
    CONSTRAINT watchlist_last_verdict_check CHECK (last_verdict = ANY (ARRAY['safe'::text, 'suspicious'::text, 'dangerous'::text, 'unknown'::text]))
);

CREATE TABLE public.alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    watchlist_id uuid,
    scan_id uuid,
    previous_verdict text,
    new_verdict text,
    is_read boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT alerts_new_verdict_check CHECK (new_verdict = ANY (ARRAY['safe'::text, 'suspicious'::text, 'dangerous'::text, 'unknown'::text])),
    CONSTRAINT alerts_previous_verdict_check CHECK (previous_verdict = ANY (ARRAY['safe'::text, 'suspicious'::text, 'dangerous'::text, 'unknown'::text]))
);

ALTER TABLE ONLY public.organizations ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.organizations ADD CONSTRAINT organizations_slug_key UNIQUE (slug);

ALTER TABLE ONLY public.users ADD CONSTRAINT users_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.scans ADD CONSTRAINT scans_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.scan_cache ADD CONSTRAINT scan_cache_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.scan_cache ADD CONSTRAINT scan_cache_cache_key_key UNIQUE (cache_key);
ALTER TABLE ONLY public.vendor_results ADD CONSTRAINT vendor_results_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.evidence_items ADD CONSTRAINT evidence_items_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.scan_feedback ADD CONSTRAINT scan_feedback_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.audit_log ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.watchlist ADD CONSTRAINT watchlist_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.alerts ADD CONSTRAINT alerts_pkey PRIMARY KEY (id);

CREATE INDEX alerts_created_at_idx ON public.alerts USING btree (created_at DESC);
CREATE INDEX alerts_is_read_idx ON public.alerts USING btree (is_read);
CREATE INDEX alerts_org_id_idx ON public.alerts USING btree (organization_id);

CREATE INDEX audit_log_created_at_idx ON public.audit_log USING btree (created_at DESC);
CREATE INDEX audit_log_org_id_idx ON public.audit_log USING btree (organization_id);

CREATE INDEX evidence_org_id_idx ON public.evidence_items USING btree (organization_id);
CREATE INDEX evidence_scan_id_idx ON public.evidence_items USING btree (scan_id);

CREATE INDEX feedback_org_id_idx ON public.scan_feedback USING btree (organization_id);
CREATE INDEX feedback_scan_id_idx ON public.scan_feedback USING btree (scan_id);

CREATE INDEX scan_cache_expires_idx ON public.scan_cache USING btree (expires_at);
CREATE INDEX scan_cache_key_idx ON public.scan_cache USING btree (cache_key);

CREATE INDEX scans_created_at_idx ON public.scans USING btree (created_at DESC);
CREATE INDEX scans_org_id_idx ON public.scans USING btree (organization_id);
CREATE INDEX scans_status_idx ON public.scans USING btree (status);
CREATE INDEX scans_verdict_idx ON public.scans USING btree (verdict);

CREATE INDEX users_org_id_idx ON public.users USING btree (organization_id);

CREATE INDEX vendor_results_org_id_idx ON public.vendor_results USING btree (organization_id);
CREATE INDEX vendor_results_scan_id_idx ON public.vendor_results USING btree (scan_id);

CREATE INDEX watchlist_indicator_idx ON public.watchlist USING btree (indicator);
CREATE INDEX watchlist_org_id_idx ON public.watchlist USING btree (organization_id);

ALTER TABLE ONLY public.users
  ADD CONSTRAINT users_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.scans
  ADD CONSTRAINT scans_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.scans
  ADD CONSTRAINT scans_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.vendor_results
  ADD CONSTRAINT vendor_results_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.vendor_results
  ADD CONSTRAINT vendor_results_scan_id_fkey
  FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evidence_items
  ADD CONSTRAINT evidence_items_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.evidence_items
  ADD CONSTRAINT evidence_items_scan_id_fkey
  FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.scan_feedback
  ADD CONSTRAINT scan_feedback_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.scan_feedback
  ADD CONSTRAINT scan_feedback_scan_id_fkey
  FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.scan_feedback
  ADD CONSTRAINT scan_feedback_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.audit_log
  ADD CONSTRAINT audit_log_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.audit_log
  ADD CONSTRAINT audit_log_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.watchlist
  ADD CONSTRAINT watchlist_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.watchlist
  ADD CONSTRAINT watchlist_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.watchlist
  ADD CONSTRAINT watchlist_last_scan_id_fkey
  FOREIGN KEY (last_scan_id) REFERENCES public.scans(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.alerts
  ADD CONSTRAINT alerts_organization_id_fkey
  FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.alerts
  ADD CONSTRAINT alerts_scan_id_fkey
  FOREIGN KEY (scan_id) REFERENCES public.scans(id) ON DELETE SET NULL;

ALTER TABLE ONLY public.alerts
  ADD CONSTRAINT alerts_watchlist_id_fkey
  FOREIGN KEY (watchlist_id) REFERENCES public.watchlist(id) ON DELETE CASCADE;

COMMIT;


