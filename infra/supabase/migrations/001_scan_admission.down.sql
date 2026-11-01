-- Gate 007A - rollback for 001_scan_admission.sql (founder-only on any real database).
-- WARNING: after this rollback the application's scan admission check fails closed (HTTP 503 for every scan)
-- until the application change is also reverted.
DROP FUNCTION IF EXISTS public.cbc_reserve_provider_call(text, bigint);
DROP TABLE IF EXISTS public.provider_call_reservations;
DROP FUNCTION IF EXISTS public.cbc_admit_scan(text);
DROP TABLE IF EXISTS public.scan_admissions;
