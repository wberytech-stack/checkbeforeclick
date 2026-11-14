// Pure mock-query regression tests: no database, network, secrets or Azure calls.
import assert from 'node:assert/strict';
import { verifyAzureRuntimeRoles } from './azure-runtime-preflight.mjs';

const tables = [
  'organizations', 'users', 'memberships', 'scans', 'vendor_results',
  'evidence_items', 'audit_log', 'scan_feedback', 'watchlist', 'alerts',
  'user_identities', 'trusted_identity_issuers', 'auth_sessions', 'scan_job_outbox',
];
const appAllowed = new Set([
  'public.app_create_scan(text,text)',
  'public.app_sign_in(text,text,text,text)',
  'public.app_resolve_auth_session(text)',
]);
const workerAllowed = new Set([
  'public.app_claim_scan_jobs(integer,integer)',
  'public.app_complete_scan_job(uuid,uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb)',
]);

function mock(role, change = {}) {
  return {
    async query(sql, params = []) {
      if (sql.includes('current_user AS role')) {
        return { rows: [{ role, rolsuper: false, rolcreatedb: false,
          rolcreaterole: false, rolbypassrls: false,
          rolinherit: role === 'cbc_app', app_member: role === 'cbc_app',
          worker_member: role === 'cbc_worker', ...(change.role ?? {}) }] };
      }
      if (sql.includes('relrowsecurity')) {
        let rows = tables.map(name => ({ name, enabled: true }));
        if (change.missingTable) rows = rows.filter(row => row.name !== change.missingTable);
        if (change.noRls) rows = rows.map(row => row.name === change.noRls ? { ...row, enabled: false } : row);
        return { rows };
      }
      if (sql.includes('has_table_privilege')) {
        const [name, privilege] = params;
        let allowed = role === 'cbc_app' && privilege === 'SELECT' &&
          ['public.scans', 'public.evidence_items'].includes(name);
        if (change.tablePrivilege?.name === name && change.tablePrivilege?.privilege === privilege) {
          allowed = change.tablePrivilege.allowed;
        }
        return { rows: [{ allowed }] };
      }
      if (sql.includes('has_function_privilege')) {
        const [name] = params;
        let allowed = (role === 'cbc_app' ? appAllowed : workerAllowed).has(name);
        if (change.functionPrivilege?.name === name) allowed = change.functionPrivilege.allowed;
        return { rows: [{ allowed }] };
      }
      throw new Error('unexpected preflight query');
    },
  };
}
const good = () => [mock('cbc_app'), mock('cbc_worker')];
let checks = 0;
await verifyAzureRuntimeRoles(...good()); checks++;
async function rejected(name, appChange, workerChange) {
  const app = mock('cbc_app', appChange);
  const worker = mock('cbc_worker', workerChange);
  await assert.rejects(() => verifyAzureRuntimeRoles(app, worker), undefined, name);
  checks++;
}
await rejected('web superuser', { role: { rolsuper: true } });
await rejected('worker bypassrls', {}, { role: { rolbypassrls: true } });
await rejected('worker role inheritance', {}, { role: { rolinherit: true } });
await rejected('worker web membership', {}, { role: { app_member: true } });
await rejected('web worker membership', { role: { worker_member: true } });
await rejected('wrong login', { role: { role: 'cbc_owner' } });
await rejected('RLS disabled', { noRls: 'scans' });
await rejected('missing session table', { missingTable: 'auth_sessions' });
await rejected('web direct evidence mutation', { tablePrivilege: {
  name: 'public.evidence_items', privilege: 'INSERT,UPDATE,DELETE', allowed: true,
} });
await rejected('worker direct outbox access', {}, { tablePrivilege: {
  name: 'public.scan_job_outbox', privilege: 'SELECT,INSERT,UPDATE,DELETE', allowed: true,
} });
await rejected('web reads session table', { tablePrivilege: {
  name: 'public.auth_sessions', privilege: 'SELECT', allowed: true,
} });
await rejected('web cannot read evidence', { tablePrivilege: {
  name: 'public.evidence_items', privilege: 'SELECT', allowed: false,
} });
await rejected('web executes worker claim', { functionPrivilege: {
  name: 'public.app_claim_scan_jobs(integer,integer)', allowed: true,
} });
await rejected('worker executes web sign in', {}, { functionPrivilege: {
  name: 'public.app_sign_in(text,text,text,text)', allowed: true,
} });
await rejected('worker missing completion grant', {}, { functionPrivilege: {
  name: 'public.app_complete_scan_job(uuid,uuid,text,text,integer,integer,text,text,integer,jsonb,jsonb)', allowed: false,
} });
await rejected('retired worker ACK still executable', {}, { functionPrivilege: {
  name: 'public.app_ack_scan_job(uuid,uuid)', allowed: true,
} });
console.log('Azure runtime role preflight: ' + checks + ' mock-query cases passed (no DB/cloud calls)');
