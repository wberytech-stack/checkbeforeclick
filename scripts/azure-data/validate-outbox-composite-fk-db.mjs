// Disposable PostgreSQL-only regression checks for migration 010.
// Never connects to a cloud or shared database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

for (const key of ['CBC_DATABASE_URL', 'CBC_TEST_OWNER_URL', 'CBC_TEST_WORKER_URL']) {
  const value = process.env[key];
  if (!value) throw new Error('Missing disposable database URL: ' + key);
  const url = new URL(value);
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/cbc_test')
    throw new Error('Refusing non-disposable database: ' + key);
}
if (!process.env.CBC_TEST_ISSUER) throw new Error('Missing test issuer');

const owner = new pg.Client({ connectionString: process.env.CBC_TEST_OWNER_URL });
const app = new pg.Client({ connectionString: process.env.CBC_DATABASE_URL });
const worker = new pg.Client({ connectionString: process.env.CBC_TEST_WORKER_URL });
let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log('PASS ' + label);
}
async function sqlState(fn) {
  try { await fn(); return null; }
  catch (error) { return error.code ?? 'unexpected'; }
}
try {
  await Promise.all([owner.connect(), app.connect(), worker.connect()]);
  await check('F01 composite FK exists on correct table with expected columns', async () => {
    const r = await owner.query(`
      SELECT c.contype, c.confdeltype,
        (SELECT array_agg(a.attname ORDER BY k.ord)
         FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,ord)
         JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum) AS columns,
        (SELECT array_agg(a.attname ORDER BY k.ord)
         FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum,ord)
         JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum) AS referenced
      FROM pg_constraint c
      WHERE c.conrelid='public.scan_job_outbox'::regclass
        AND c.confrelid='public.scans'::regclass
        AND c.conname='fk_scan_job_outbox_scan_org'`);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].contype, 'f');
    assert.equal(r.rows[0].confdeltype, 'c');
    assert.deepEqual(r.rows[0].columns, ['scan_id', 'organization_id']);
    assert.deepEqual(r.rows[0].referenced, ['id', 'organization_id']);
  });
  const subject = 'fk-' + randomUUID();
  const signed = await app.query('SELECT * FROM public.app_sign_in($1,$2,$3,$4)',
    [process.env.CBC_TEST_ISSUER, subject, subject + '@example.test', 'FK test']);
  const user = signed.rows[0].o_user_id;
  const org = signed.rows[0].o_organization_id;
  await app.query('BEGIN');
  let scan;
  try {
    await app.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.current_organization_id',$2,true)", [user, org]);
    scan = (await app.query("SELECT public.app_create_scan('url',$1) AS id", ['https://composite-fk.example'])).rows[0].id;
    await app.query('COMMIT');
  } catch (error) {
    await app.query('ROLLBACK');
    throw error;
  }
  await check('F02 trigger-created outbox row matches scan tenant', async () => {
    const r = await owner.query(
      'SELECT s.organization_id AS scan_org,j.organization_id AS job_org,j.state FROM public.scans s JOIN public.scan_job_outbox j ON j.scan_id=s.id WHERE s.id=$1',
      [scan]);
    assert.equal(r.rows.length, 1);
    assert.deepEqual(r.rows[0], { scan_org: org, job_org: org, state: 'ready' });
  });
  await check('F03 mismatched tenant rejected by FK, not PK or lease check', async () => {
    const other = (await app.query('SELECT * FROM public.app_sign_in($1,$2,$3,$4)',
      [process.env.CBC_TEST_ISSUER, 'other-' + randomUUID(), 'other@example.test', 'Other tenant'])).rows[0].o_organization_id;
    assert.notEqual(other, org);
    assert.equal(await sqlState(() => owner.query(
      'UPDATE public.scan_job_outbox SET organization_id=$2 WHERE scan_id=$1',
      [scan, other])), '23503');
    const r = await owner.query('SELECT organization_id FROM public.scan_job_outbox WHERE scan_id=$1', [scan]);
    assert.equal(r.rows[0].organization_id, org);
  });
  await check('F04 restricted identities cannot directly mutate protected scan/outbox rows', async () => {
    const appRole = await app.query('SELECT current_user AS role');
    const workerRole = await worker.query('SELECT current_user AS role');
    assert.equal(appRole.rows[0].role, 'cbc_app');
    assert.equal(workerRole.rows[0].role, 'cbc_worker');
    assert.equal(await sqlState(() => app.query(
      'UPDATE public.scan_job_outbox SET organization_id=$2 WHERE scan_id=$1', [scan, org])), '42501');
    assert.equal(await sqlState(() => worker.query(
      'UPDATE public.scan_job_outbox SET organization_id=$2 WHERE scan_id=$1', [scan, org])), '42501');
    assert.equal(await sqlState(() => worker.query(
      "UPDATE public.scans SET status='complete' WHERE id=$1", [scan])), '42501');
  });
  await check('F05 existing outbox has zero mismatched scan/tenant associations', async () => {
    const r = await owner.query(`
      SELECT count(*)::int AS n FROM public.scan_job_outbox j
      LEFT JOIN public.scans s ON s.id=j.scan_id AND s.organization_id=j.organization_id
      WHERE s.id IS NULL`);
    assert.equal(r.rows[0].n, 0);
  });
} catch (error) {
  console.error('FAIL composite FK regression: ' + String(error));
  process.exitCode = 1;
} finally {
  await Promise.all([owner.end().catch(() => {}), app.end().catch(() => {}), worker.end().catch(() => {})]);
}
console.log('\n=== Azure outbox composite FK: ' + passed + ' passed, ' + (process.exitCode ? 1 : 0) + ' failed ===');
