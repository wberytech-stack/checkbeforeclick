-- Gate 006C / 007A: DRAFT Supabase browser-role privilege hardening.
-- NOT APPLIED. Not authorized for staging or production.
-- Target: Supabase Postgres, not infra/db (Azure PostgreSQL).
-- New migration only; do not edit previously recorded migrations.
--
-- Staging catalog evidence (2026-11-01 UTC, project zgxmvpbvvakpsnzcymsf):
--   anon/authenticated have direct DML and TRUNCATE grants on ten public tables;
--   scan_cache has global authenticated SELECT/INSERT/UPDATE policies;
--   organizations and scans have own-org UPDATE policies but no column restrictions;
--   evidence_items and vendor_results have own-org INSERT policies and
--   browser INSERT grants despite server-only evidence/provider writes.
-- This is a privilege/policy exposure, not an exploit demonstration.
--
-- Design: browser sessions may read tenant-scoped data under existing RLS and
-- authenticated users may edit their own full_name. Scan creation, verdict
-- writes, organization changes, evidence/vendor writes, and shared cache
-- access remain server-owned.
-- The existing server-side data chokepoint uses service_role; cbc_admit_scan and
-- cbc_reserve_provider_call are SECURITY DEFINER RPCs called as authenticated.
-- No policy, trigger, RPC, function ownership, service_role grant or data is changed.
--
-- STOP: validate on a disposable local Supabase-compatible PostgreSQL database
-- with both positive and negative role/row tests before founder review.
-- Migration 002_users_identity_guard.sql remains a separate prerequisite.
-- Recheck real app paths (signup, profile, J5 scan, scan status, history, RPC)
-- in a disposable environment; no real DB apply is authorized here.
--
-- NOTE: this hardens existing tables only. Supabase's default privileges for
-- newly created public tables must be reviewed in a separate approved change.
BEGIN;

-- TRUNCATE bypasses RLS. No browser role needs it on any existing public table.
-- Existing service_role and postgres privileges are deliberately untouched.
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- The app creates scans through the privileged server chokepoint AFTER admission.
-- Direct authenticated INSERT could bypass the scan-admission quota; direct
-- UPDATE could falsify verdicts and status. Organization billing/plan fields
-- likewise must not be writable directly from the browser.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.scans FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.organizations FROM anon, authenticated;

-- Evidence and provider results are produced by the privileged server-side
-- scan lifecycle. Direct authenticated INSERT under the existing own-org RLS
-- policy could forge results for scans in that organization. Preserve reads
-- under RLS but deny direct browser writes (including future UPDATE/DELETE).
REVOKE INSERT, UPDATE, DELETE ON TABLE public.evidence_items, public.vendor_results FROM anon, authenticated;

-- Profile identity and tenant pointer are server-owned. Retain only a narrow
-- direct self-profile edit under the existing users_update_own_profile RLS
-- policy. A separate identity trigger (draft migration 002) remains required
-- as defense in depth against future privilege or policy regressions.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.users FROM anon, authenticated;
GRANT UPDATE (full_name) ON TABLE public.users TO authenticated;

-- scan_cache has no tenant pointer and its current policies allow every
-- authenticated user to read and write the shared result cache. It is not a
-- browser API. Remove browser-role table access; leave service_role unchanged.
REVOKE ALL ON TABLE public.scan_cache FROM anon, authenticated;

COMMIT;
