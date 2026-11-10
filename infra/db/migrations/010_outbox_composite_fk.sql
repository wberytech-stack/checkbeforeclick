-- Gate 008A / 010: tenant-consistent scan outbox relationship.
-- DRAFT ONLY. Apply after 001-009 on an explicitly verified database.
-- Run as the schema owner, not cbc_app or cbc_worker. No data migration.
BEGIN;

-- Refuse to conceal pre-existing mismatches. A standalone scan_id FK cannot
-- guarantee that an outbox row references the scan's own organization.
DO $audit$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.scan_job_outbox j
    LEFT JOIN public.scans s
      ON s.id = j.scan_id AND s.organization_id = j.organization_id
    WHERE s.id IS NULL
  ) THEN
    RAISE EXCEPTION '010: outbox scan/organization mismatch; investigate before migration';
  END IF;
END;
$audit$;

-- Check the target relation OID, not just the constraint name elsewhere.
-- A UNIQUE constraint supplies the composite FK's required referenced key.
DO $unique$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.scans'::pg_catalog.regclass
      AND c.conname = 'scans_id_org_id_uq'
      AND c.contype = 'u'
      AND c.conkey = ARRAY[
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.scans'::pg_catalog.regclass AND a.attname = 'id'),
        (SELECT a.attnum FROM pg_catalog.pg_attribute a
         WHERE a.attrelid = 'public.scans'::pg_catalog.regclass AND a.attname = 'organization_id')
      ]::smallint[]
  ) THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_constraint c
      WHERE c.conrelid = 'public.scans'::pg_catalog.regclass
        AND c.conname = 'scans_id_org_id_uq'
    ) THEN
      RAISE EXCEPTION '010: existing scans_id_org_id_uq has unexpected definition';
    END IF;
    ALTER TABLE public.scans
      ADD CONSTRAINT scans_id_org_id_uq UNIQUE (id, organization_id);
  END IF;
END;
$unique$;

DO $foreign_key$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = 'public.scan_job_outbox'::pg_catalog.regclass
      AND c.conname = 'fk_scan_job_outbox_scan_org'
  ) THEN
    RAISE EXCEPTION '010: fk_scan_job_outbox_scan_org already exists; verify definition manually';
  END IF;
  ALTER TABLE public.scan_job_outbox
    ADD CONSTRAINT fk_scan_job_outbox_scan_org
    FOREIGN KEY (scan_id, organization_id)
    REFERENCES public.scans (id, organization_id)
    ON DELETE CASCADE;
END;
$foreign_key$;
COMMIT;
