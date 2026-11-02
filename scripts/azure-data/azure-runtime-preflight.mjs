// Read-only Azure clean-start PostgreSQL runtime contract preflight.
// The executable mode is intentionally restricted to disposable loopback
// databases. Live Azure verification needs separate founder approval.
// No data writes, schema changes, cloud calls, or secret values in output.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const TABLES = [
  'organizations', 'users', 'memberships', 'scans', 'vendor_results',
  'evidence_items', 'audit_log', 'scan_feedback', 'watchlist', 'alerts',
  'user_identities', 'trusted_identity_issuers', 'auth_sessions', 'scan_job_outbox',
];
const PROTECTED_WRITES = [
  'organizations', 'scans', 'vendor_results', 'evidence_items',
  'audit_log', 'trusted_identity_issuers', 'auth_sessions', 'scan_job_outbox',
];
const SCAN_CREATE = 'public.app_create_scan(text,text)';
const SIGN_IN = 'public.app_sign_in(text,text,text,text)';
const RESOLVE_SESSION = 'public.app_resolve_auth_session(text)';
const CLAIM = 'public.app_claim_scan_jobs(integer,integer)';
const COMPLETE = 'public.app_complete_scan_job(uuid,uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb)';
const ACK = 'public.app_ack_scan_job(uuid,uuid)';
const MARK = 'public.app_mark_scan_processing(uuid)';

const ROLE_SQL = `SELECT current_user AS role, r.rolsuper, r.rolcreatedb,
 r.rolcreaterole, r.rolbypassrls, r.rolinherit,
 pg_has_role(current_user, 'cbc_app', 'MEMBER') AS app_member,
 pg_has_role(current_user, 'cbc_worker', 'MEMBER') AS worker_member
 FROM pg_catalog.pg_roles r WHERE r.rolname = current_user`;
const RLS_SQL = `SELECT c.relname AS name, c.relrowsecurity AS enabled
 FROM pg_catalog.pg_class c
 JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
 AND c.relname = ANY($1::text[])`;
const TABLE_PRIV_SQL = `SELECT has_table_privilege(current_user, $1, $2) AS allowed`;
const FUNCTION_PRIV_SQL = `SELECT has_function_privilege(current_user, $1::regprocedure, 'EXECUTE') AS allowed`;

function exactBoolean(value, expected, label) {
  assert.equal(typeof value, 'boolean', label + ' must be a boolean');
  assert.equal(value, expected, label);
}
async function one(db, sql, params = []) {
  const result = await db.query(sql, params);
  assert.equal(result?.rows?.length, 1, 'preflight expected exactly one result');
  return result.rows[0];
}
async function tablePrivilege(db, name, privilege, expected) {
  const row = await one(db, TABLE_PRIV_SQL, ['public.' + name, privilege]);
  exactBoolean(row.allowed, expected, name + ' ' + privilege);
}
async function functionPrivilege(db, signature, expected) {
  const row = await one(db, FUNCTION_PRIV_SQL, [signature]);
  exactBoolean(row.allowed, expected, signature + ' EXECUTE');
}

export async function verifyAzureRuntimeRoles(appDb, workerDb) {
  // The queries use catalog introspection only. No tenant data is read.
  for (const [db, role] of [[appDb, 'cbc_app'], [workerDb, 'cbc_worker']]) {
    const r = await one(db, ROLE_SQL);
    assert.equal(r.role, role, 'wrong database login / principal binding');
    for (const flag of ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolbypassrls']) {
      exactBoolean(r[flag], false, role + '.' + flag);
    }
    if (role === 'cbc_app') {
      exactBoolean(r.worker_member, false, 'web must not inherit worker role');
    } else {
      exactBoolean(r.rolinherit, false, 'worker must be NOINHERIT');
      exactBoolean(r.app_member, false, 'worker must not inherit web role');
    }
  }

  const rls = await appDb.query(RLS_SQL, [TABLES]);
  assert.ok(Array.isArray(rls?.rows), 'RLS catalog unavailable');
  const found = new Map(rls.rows.map(row => [row.name, row.enabled]));
  assert.equal(found.size, TABLES.length, 'missing tenant/security table');
  for (const name of TABLES) exactBoolean(found.get(name), true, name + ' RLS');

  for (const name of PROTECTED_WRITES) {
    await tablePrivilege(appDb, name, 'INSERT,UPDATE,DELETE', false);
    await tablePrivilege(workerDb, name, 'SELECT,INSERT,UPDATE,DELETE', false);
  }
  await tablePrivilege(appDb, 'scans', 'SELECT', true);
  await tablePrivilege(appDb, 'evidence_items', 'SELECT', true);
  await tablePrivilege(appDb, 'auth_sessions', 'SELECT', false);
  await tablePrivilege(appDb, 'trusted_identity_issuers', 'SELECT', false);

  for (const f of [SCAN_CREATE, SIGN_IN, RESOLVE_SESSION]) {
    await functionPrivilege(appDb, f, true);
    await functionPrivilege(workerDb, f, false);
  }
  for (const f of [CLAIM, COMPLETE]) {
    await functionPrivilege(workerDb, f, true);
    await functionPrivilege(appDb, f, false);
  }
  for (const f of [ACK, MARK]) {
    await functionPrivilege(appDb, f, false);
    await functionPrivilege(workerDb, f, false);
  }
  return { roles: 2, rlsTables: TABLES.length, protectedTables: PROTECTED_WRITES.length };
}

function disposableUrl(raw, expectedRole) {
  assert.ok(raw, 'missing disposable database URL');
  const url = new URL(raw);
  assert.equal(url.protocol, 'postgres:', 'only postgres URLs accepted');
  assert.equal(url.hostname, '127.0.0.1', 'preflight refuses non-loopback hosts');
  assert.equal(url.pathname, '/cbc_test', 'preflight refuses non-disposable database');
  assert.equal(decodeURIComponent(url.username), expectedRole, 'wrong disposable role');
  assert.ok(url.password.length > 0, 'disposable database password required');
  assert.equal(url.search, '', 'query parameters forbidden');
  assert.equal(url.hash, '', 'fragments forbidden');
  return raw;
}

async function runDisposable() {
  const appUrl = disposableUrl(process.env.CBC_DATABASE_URL, 'cbc_app');
  const workerUrl = disposableUrl(process.env.CBC_TEST_WORKER_URL, 'cbc_worker');
  const { Client } = await import('pg');
  const app = new Client({ connectionString: appUrl, ssl: false, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
  const worker = new Client({ connectionString: workerUrl, ssl: false, statement_timeout: 5000, connectionTimeoutMillis: 5000 });
  try {
    await app.connect();
    await worker.connect();
    const result = await verifyAzureRuntimeRoles(app, worker);
    console.log('Azure runtime role preflight passed (disposable PostgreSQL only): ' +
      result.roles + ' roles, ' + result.rlsTables + ' RLS tables, ' +
      result.protectedTables + ' protected write surfaces');
  } finally {
    await Promise.allSettled([app.end(), worker.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 || process.argv[2] !== '--disposable') {
    console.error('Usage: node scripts/azure-data/azure-runtime-preflight.mjs --disposable');
    process.exitCode = 2;
  } else {
    runDisposable().catch(() => {
      // Never print PostgreSQL errors or credentials.
      console.error('Azure runtime role preflight failed (disposable database)');
      process.exitCode = 1;
    });
  }
}
