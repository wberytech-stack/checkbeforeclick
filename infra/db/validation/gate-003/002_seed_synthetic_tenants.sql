-- ============================================================================
-- 002_seed_synthetic_tenants.sql
-- Gate 003B disposable-DB validation script
--------------------------------------------

-- RUN ONLY AGAINST: cbc_003_validation
-- NEVER RUN AGAINST: cbc_prod
------------------------------

-- Expected precondition:
-- 1. 001_initial_schema.sql has already been applied to cbc_003_validation.
-- 2. 002_tenant_isolation.sql has already been applied to cbc_003_validation.
-- 3. 001_create_cbc_app_validation_role.sql has already been applied.
-- 4. This script is run as the migration/admin user.
-----------------------------------------------------

-- Purpose:
-- Seed deterministic synthetic tenant data for validating cbc_app RLS behavior.
--------------------------------------------------------------------------------

-- This script intentionally uses admin/migration privileges to seed data.
-- Runtime validation happens in 003_validate_cbc_app_rls.sql.
-- ============================================================================

---

-- 0. Confirm target database

---

SELECT
'CHECK_DATABASE' AS test,
current_database() AS database_name,
CASE
WHEN current_database() = 'cbc_003_validation' THEN 'PASS'
ELSE 'FAIL - wrong database, stop immediately'
END AS result;

DO $$
BEGIN
IF current_database() <> 'cbc_003_validation' THEN
RAISE EXCEPTION 'Refusing to run outside cbc_003_validation. Current database: %', current_database();
END IF;
END;
$$;

---

-- 1. Clear disposable validation data

---

TRUNCATE
public.alerts,
public.watchlist,
public.audit_log,
public.scan_feedback,
public.evidence_items,
public.vendor_results,
public.scans,
public.scan_cache,
public.memberships,
public.users,
public.organizations
CASCADE;

---

-- 2. Seed organizations

---

INSERT INTO public.organizations (id, name, slug, plan)
VALUES
(
'11111111-1111-1111-1111-111111111111',
'Gate 003 Org A',
'gate-003-org-a',
'team'
),
(
'22222222-2222-2222-2222-222222222222',
'Gate 003 Org B',
'gate-003-org-b',
'team'
);

---

-- 3. Seed users

---

INSERT INTO public.users (id, organization_id, full_name, role)
VALUES
(
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'11111111-1111-1111-1111-111111111111',
'Gate 003 Org A Owner',
'admin'
),
(
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
'11111111-1111-1111-1111-111111111111',
'Gate 003 Org A Member',
'member'
),
(
'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
'22222222-2222-2222-2222-222222222222',
'Gate 003 Org B Owner',
'admin'
);

---

-- 4. Seed memberships

---

INSERT INTO public.memberships (user_id, organization_id, role)
VALUES
(
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'11111111-1111-1111-1111-111111111111',
'owner'
),
(
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2',
'11111111-1111-1111-1111-111111111111',
'member'
),
(
'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
'22222222-2222-2222-2222-222222222222',
'owner'
);

---

-- 5. Seed scans

---

INSERT INTO public.scans (
id,
organization_id,
user_id,
input_type,
raw_input,
status,
verdict,
risk_score,
confidence_score
)
VALUES
(
'33333333-3333-3333-3333-333333333331',
'11111111-1111-1111-1111-111111111111',
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'url',
'https://gate-003-org-a.example.test',
'complete',
'safe',
10,
90
),
(
'44444444-4444-4444-4444-444444444441',
'22222222-2222-2222-2222-222222222222',
'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
'url',
'https://gate-003-org-b.example.test',
'complete',
'dangerous',
90,
95
);

---

-- 6. Seed vendor results

---

INSERT INTO public.vendor_results (
id,
scan_id,
organization_id,
vendor_name,
verdict,
raw_response,
response_time_ms
)
VALUES
(
'55555555-5555-5555-5555-555555555551',
'33333333-3333-3333-3333-333333333331',
'11111111-1111-1111-1111-111111111111',
'gate_003_validation_vendor',
'safe',
'{"source":"gate_003","tenant":"org_a"}'::jsonb,
100
),
(
'55555555-5555-5555-5555-555555555552',
'44444444-4444-4444-4444-444444444441',
'22222222-2222-2222-2222-222222222222',
'gate_003_validation_vendor',
'dangerous',
'{"source":"gate_003","tenant":"org_b"}'::jsonb,
100
);

---

-- 7. Seed evidence items

---

INSERT INTO public.evidence_items (
id,
scan_id,
organization_id,
signal_type,
severity,
title,
detail,
score_impact
)
VALUES
(
'66666666-6666-6666-6666-666666666661',
'33333333-3333-3333-3333-333333333331',
'11111111-1111-1111-1111-111111111111',
'validation',
'info',
'Gate 003 Org A evidence',
'Synthetic evidence for Org A.',
0
),
(
'66666666-6666-6666-6666-666666666662',
'44444444-4444-4444-4444-444444444441',
'22222222-2222-2222-2222-222222222222',
'validation',
'high',
'Gate 003 Org B evidence',
'Synthetic evidence for Org B.',
50
);

---

-- 8. Seed scan feedback

---

INSERT INTO public.scan_feedback (
id,
scan_id,
organization_id,
user_id,
feedback_type,
comment
)
VALUES
(
'77777777-7777-7777-7777-777777777771',
'33333333-3333-3333-3333-333333333331',
'11111111-1111-1111-1111-111111111111',
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'correct',
'Synthetic Org A feedback.'
),
(
'77777777-7777-7777-7777-777777777772',
'44444444-4444-4444-4444-444444444441',
'22222222-2222-2222-2222-222222222222',
'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
'correct',
'Synthetic Org B feedback.'
);

---

-- 9. Seed watchlist rows

---

INSERT INTO public.watchlist (
id,
organization_id,
user_id,
indicator,
indicator_type,
last_verdict,
last_scan_id,
last_scanned_at
)
VALUES
(
'88888888-8888-8888-8888-888888888881',
'11111111-1111-1111-1111-111111111111',
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'gate-003-org-a.example.test',
'domain',
'safe',
'33333333-3333-3333-3333-333333333331',
now()
),
(
'88888888-8888-8888-8888-888888888882',
'22222222-2222-2222-2222-222222222222',
'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
'gate-003-org-b.example.test',
'domain',
'dangerous',
'44444444-4444-4444-4444-444444444441',
now()
);

---

-- 10. Seed alerts

---

INSERT INTO public.alerts (
id,
organization_id,
watchlist_id,
scan_id,
previous_verdict,
new_verdict,
is_read
)
VALUES
(
'99999999-9999-9999-9999-999999999991',
'11111111-1111-1111-1111-111111111111',
'88888888-8888-8888-8888-888888888881',
'33333333-3333-3333-3333-333333333331',
'unknown',
'safe',
false
),
(
'99999999-9999-9999-9999-999999999992',
'22222222-2222-2222-2222-222222222222',
'88888888-8888-8888-8888-888888888882',
'44444444-4444-4444-4444-444444444441',
'unknown',
'dangerous',
false
);

---

-- 11. Seed audit log rows

---

INSERT INTO public.audit_log (
id,
organization_id,
user_id,
action,
target_type,
target_id,
metadata
)
VALUES
(
'aaaaaaaa-0000-0000-0000-000000000001',
'11111111-1111-1111-1111-111111111111',
'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1',
'gate_003.org_a_seeded',
'scan',
'33333333-3333-3333-3333-333333333331',
'{"source":"gate_003"}'::jsonb
),
(
'bbbbbbbb-0000-0000-0000-000000000001',
'22222222-2222-2222-2222-222222222222',
'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
'gate_003.org_b_seeded',
'scan',
'44444444-4444-4444-4444-444444444441',
'{"source":"gate_003"}'::jsonb
);

---

-- 12. Seed scan_cache row for negative privilege validation

---

INSERT INTO public.scan_cache (
id,
cache_key,
vendor_name,
result,
expires_at
)
VALUES
(
'cccccccc-0000-0000-0000-000000000001',
'gate-003-global-cache-key',
'gate_003_validation_vendor',
'{"verdict":"safe","source":"gate_003"}'::jsonb,
now() + interval '1 day'
);

---

-- 13. Confirm seed counts

---

SELECT
'CHECK_GATE_003B_SEED_COUNTS' AS test,
(SELECT count(*) FROM public.organizations) AS organizations,
(SELECT count(*) FROM public.users) AS users,
(SELECT count(*) FROM public.memberships) AS memberships,
(SELECT count(*) FROM public.scans) AS scans,
(SELECT count(*) FROM public.vendor_results) AS vendor_results,
(SELECT count(*) FROM public.evidence_items) AS evidence_items,
(SELECT count(*) FROM public.scan_feedback) AS scan_feedback,
(SELECT count(*) FROM public.watchlist) AS watchlist,
(SELECT count(*) FROM public.alerts) AS alerts,
(SELECT count(*) FROM public.audit_log) AS audit_log,
(SELECT count(*) FROM public.scan_cache) AS scan_cache,
CASE
WHEN (SELECT count(*) FROM public.organizations) = 2
AND (SELECT count(*) FROM public.users) = 3
AND (SELECT count(*) FROM public.memberships) = 3
AND (SELECT count(*) FROM public.scans) = 2
AND (SELECT count(*) FROM public.vendor_results) = 2
AND (SELECT count(*) FROM public.evidence_items) = 2
AND (SELECT count(*) FROM public.scan_feedback) = 2
AND (SELECT count(*) FROM public.watchlist) = 2
AND (SELECT count(*) FROM public.alerts) = 2
AND (SELECT count(*) FROM public.audit_log) = 2
AND (SELECT count(*) FROM public.scan_cache) = 1
THEN 'PASS'
ELSE 'FAIL'
END AS result;

---

-- 14. Completion marker

---

SELECT
'GATE_003B_002_SEED_SYNTHETIC_TENANTS_COMPLETE' AS test,
'PASS' AS result;
