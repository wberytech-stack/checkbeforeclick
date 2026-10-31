-- Gate 006C - founder-run cleanup of ONE staging-auth-journeys test scan.
--
-- STAGING ONLY: run in the SQL editor of Supabase project zgxmvpbvvakpsnzcymsf
-- (checkbeforeclick-staging). Confirm the project ref in the dashboard URL first.
--
-- Fill in the three values from the run output ("Test data created by this run") and
-- from step 3.2 (account A's user id), then run the whole script at once.
--
-- Everything is checked BEFORE anything is deleted, inside one transaction:
--   * exactly one scan with that id, owned by account A, in A's organization, of type
--     url, whose raw_input is exactly http://localhost/cbc-staging-journey/<run id>;
--   * exactly 1 evidence_items row and 0 vendor_results rows for that scan, all in the
--     same organization (what a localhost scan writes: app/api/scan/route.ts);
--   * each delete is limited to those rows and must remove exactly the expected count.
-- Any mismatch raises an exception, which aborts the transaction: nothing is deleted
-- and the final COMMIT ends as a ROLLBACK. Expected success notice:
--   cleanup ok: scans 1, evidence_items 1, vendor_results 0

begin;

do $$
declare
  v_scan   uuid := '<scan id>';            -- from the run output
  v_user   uuid := '<account A user id>';  -- from step 3.2
  v_run    text := '<run id>';             -- from the run output
  v_input  text;
  v_org    uuid;
  n        integer;
begin
  if v_run !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'run id is not a UUID; nothing deleted';
  end if;
  v_input := 'http://localhost/cbc-staging-journey/' || v_run;

  select u.organization_id into v_org from public.users u where u.id = v_user;
  if v_org is null then
    raise exception 'account A has no users row or organization; nothing deleted';
  end if;

  select count(*) into n from public.scans s
   where s.id = v_scan and s.user_id = v_user and s.organization_id = v_org
     and s.input_type = 'url' and s.raw_input = v_input;
  if n <> 1 then
    raise exception 'expected exactly 1 matching test scan, found %; nothing deleted', n;
  end if;

  select count(*) into n from public.evidence_items e where e.scan_id = v_scan;
  if n <> 1 then
    raise exception 'expected exactly 1 evidence_items row, found %; nothing deleted', n;
  end if;
  select count(*) into n from public.evidence_items e where e.scan_id = v_scan and e.organization_id = v_org;
  if n <> 1 then
    raise exception 'evidence_items row is not in account A''s organization; nothing deleted';
  end if;

  select count(*) into n from public.vendor_results v where v.scan_id = v_scan;
  if n <> 0 then
    raise exception 'expected 0 vendor_results rows, found %; nothing deleted', n;
  end if;

  delete from public.evidence_items e where e.scan_id = v_scan and e.organization_id = v_org;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'evidence_items delete removed % rows, expected 1; rolled back', n; end if;

  delete from public.scans s
   where s.id = v_scan and s.user_id = v_user and s.organization_id = v_org
     and s.input_type = 'url' and s.raw_input = v_input;
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'scans delete removed % rows, expected 1; rolled back', n; end if;

  raise notice 'cleanup ok: scans 1, evidence_items 1, vendor_results 0';
end
$$;

commit;
