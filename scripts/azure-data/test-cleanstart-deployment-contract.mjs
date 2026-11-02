// Cross-component clean-start deployment contract. No Azure, database or network I/O.
// Checks the actual source boundaries together: Bicep -> runtime env -> image -> DB.
// CI runs this before any deployment approval; it is not a substitute for live RBAC.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const sources = {
  webIaC: read('infra/azure/hosting/azure-only-web.bicep'),
  workerIaC: read('infra/azure/hosting/azure-url-worker-job.bicep'),
  webImage: read('Dockerfile.azure-web'),
  workerImage: read('Dockerfile.azure-worker'),
  webDb: read('src/server/db/postgres.ts'),
  dbConfig: read('src/server/db/config.ts'),
  webAuth: read('src/server/auth/azureRuntimeConfig.ts'),
  workerPg: read('src/server/workers/azureWorkerPg.ts'),
  workerRuntime: read('src/server/workers/azureWorkerRuntime.ts'),
  workerEntry: read('src/server/workers/azureUrlWorkerEntry.ts'),
  workerMain: read('scripts/azure-data/azure-url-worker-main.ts'),
  migrations: [5, 6, 7, 8, 9].map(n => read('infra/db/migrations/00' + n + '_' +
    ({5:'identity_and_scan_integrity',6:'oidc_login_state',7:'auth_sessions',8:'scan_job_outbox',9:'worker_scan_completion'})[n] + '.sql')),
};

function envBlock(iac) {
  const start = iac.indexOf('          env: [');
  assert.ok(start !== -1, 'Container env block missing');
  const end = iac.indexOf('\n          ]', start);
  assert.ok(end !== -1, 'Container env block not terminated');
  const block = iac.slice(start, end);
  const result = new Map();
  for (const m of block.matchAll(/name:\s*'([^']+)'\s*,?\s*(value|secretRef):\s*([^\n]+)/g)) {
    assert.ok(!result.has(m[1]), 'Duplicate environment variable: ' + m[1]);
    result.set(m[1], { kind: m[2], value: m[3].trim().replace(/\s*}\s*$/, '').replace(/,$/, '').trim() });
  }
  assert.ok(result.size >= 3, 'No container environment entries parsed');
  return result;
}
function requireEnv(env, name, kind, expected) {
  const entry = env.get(name);
  assert.ok(entry, 'Missing ' + name);
  assert.equal(entry.kind, kind, name + ' binding type');
  assert.equal(entry.value, expected, name + ' binding value');
}
function mustHave(text, pattern, label) {
  assert.match(text, pattern, label);
}
function mustNotHave(text, pattern, label) {
  assert.doesNotMatch(text, pattern, label);
}

function validate(s) {
  const web = envBlock(s.webIaC);
  const worker = envBlock(s.workerIaC);
  const webDb = "'postgres://cbc_app@${databaseHost}:5432/${databaseName}'";
  const workerDb = "'postgres://cbc_worker@${databaseHost}:5432/${databaseName}'";

  // Database and identity bindings are deliberately asymmetric.
  requireEnv(web, 'CBC_DATABASE_URL', 'value', webDb);
  requireEnv(web, 'CBC_DATABASE_AUTH', 'value', "'entra'");
  requireEnv(web, 'AZURE_CLIENT_ID', 'value', 'webIdentity!.properties.clientId');
  requireEnv(worker, 'CBC_WORKER_DATABASE_URL', 'value', workerDb);
  requireEnv(worker, 'CBC_WORKER_AZURE_CLIENT_ID', 'value', 'workerIdentity!.properties.clientId');
  requireEnv(worker, 'AZURE_CLIENT_ID', 'value', 'webIdentity.properties.clientId');
  mustHave(s.workerIaC, /resource webIdentity 'Microsoft\.ManagedIdentity\/userAssignedIdentities@[^']+' existing =/, 'Worker must reference existing web identity for comparison');
  mustHave(s.workerIaC, /userAssignedIdentities:\s*\{\s*'\$\{workerIdentity!\.id\}': \{\}/, 'Worker must attach only its dedicated identity');
  mustHave(s.webIaC, /userAssignedIdentities:\s*\{\s*'\$\{webIdentity!\.id\}': \{\}/, 'Web must attach only its dedicated identity');
  mustHave(s.workerPg, /env\.CBC_WORKER_DATABASE_URL\s*\|\|\s*!env\.CBC_WORKER_AZURE_CLIENT_ID/, 'Worker must fail without dedicated settings');
  mustHave(s.workerPg, /CBC_DATABASE_URL:\s*env\.CBC_WORKER_DATABASE_URL/, 'Worker DB URL source');
  mustHave(s.workerPg, /AZURE_CLIENT_ID:\s*env\.CBC_WORKER_AZURE_CLIENT_ID/, 'Worker token must use worker identity, not web identity');
  mustHave(s.workerPg, /webIdentityClientId:\s*env\.AZURE_CLIENT_ID/, 'Worker must check identity separation');
  mustHave(s.workerRuntime, /config\.user === "cbc_worker"/, 'Worker role assertion');
  mustHave(s.workerRuntime, /clientId\.toLowerCase\(\) !== webClientId\.toLowerCase\(\)/, 'Worker must reject identity reuse');
  mustHave(s.dbConfig, /cloud databases require CBC_DATABASE_AUTH=entra/, 'Cloud must use Entra database authentication');
  mustHave(s.webDb, /createManagedIdentityTokenProvider/, 'Web database must obtain a managed identity token');

  // Browser OIDC config, cookie sealing and DB auth must all be injected by IaC.
  for (const key of ['CBC_AZURE_PUBLIC_ORIGIN', 'CBC_AZURE_OIDC_ISSUER', 'CBC_AZURE_OIDC_CLIENT_ID',
    'CBC_AZURE_OIDC_STATE_ACTIVE_KID', 'CBC_AZURE_OIDC_STATE_KEYS']) {
    assert.ok(web.has(key), 'Missing OIDC web setting: ' + key);
    assert.ok(s.webAuth.includes('env.' + key), 'OIDC parser does not consume ' + key);
    assert.ok(!worker.has(key), 'OIDC secret/config leaked to worker: ' + key);
  }
  requireEnv(web, 'CBC_AZURE_OIDC_STATE_KEYS', 'secretRef', "'oidc-state-keys'");
  requireEnv(web, 'CBC_AZURE_ONLY_MODE', 'value', "'1'");
  mustHave(s.webIaC, /scope:\s*stateSecret/, 'Web vault access must be secret scoped');
  mustHave(s.workerIaC, /scope:\s*providerSecret/, 'Worker vault access must be secret scoped');
  requireEnv(worker, 'CBC_WEB_RISK_API_KEY', 'secretRef', "'web-risk-key'");
  mustHave(s.workerEntry, /process\.env\.CBC_WEB_RISK_API_KEY/, 'Worker must consume provider key');
  assert.ok(!web.has('CBC_WEB_RISK_API_KEY'), 'Provider key must not reach web');
  assert.ok(!worker.has('CBC_DATABASE_URL'), 'Worker must not receive web DB URL');
  assert.ok(!web.has('CBC_WORKER_DATABASE_URL'), 'Web must not receive worker DB URL');
  assert.ok(!web.has('CBC_WORKER_AZURE_CLIENT_ID'), 'Web must not receive worker identity');
  for (const [name] of [...web, ...worker]) {
    assert.ok(!/SUPABASE|INNGEST|VERCEL|SERVICE_ROLE_KEY/.test(name), 'Legacy runtime setting: ' + name);
  }

  // Container image/entrypoint contracts must match the deployment references.
  mustHave(s.webIaC, /cbc-azure-web@sha256:\$\{webImageSha256\}/, 'Web image digest contract');
  mustHave(s.workerIaC, /cbc-azure-worker@sha256:\$\{workerImageSha256\}/, 'Worker image digest contract');
  mustHave(s.webImage, /CMD \["node", "server\.js"\]/, 'Web image entrypoint');
  mustHave(s.workerImage, /CMD \["node", "\.azure-worker-dist\/scripts\/azure-data\/azure-url-worker-main\.js"\]/, 'Worker image entrypoint');
  mustHave(s.workerImage, /tsc --project tsconfig\.azure-worker\.json/, 'Worker image compile contract');
  mustHave(s.workerMain, /runAzureUrlWorkerOnce\(\)/, 'Worker job invocation');
  mustHave(s.webIaC, /path: '\/api\/healthz'/, 'Web health probe path');
  mustHave(s.webImage, /\/api\/healthz/, 'Web image health probe path');
  mustNotHave(s.workerIaC, /\bingress\s*:/, 'Worker must have no ingress');

  // One durable PostgreSQL scan job flow, not an unconnected second queue.
  mustHave(s.migrations[3], /scan_job_outbox/, 'Migration 008 outbox');
  mustHave(s.migrations[4], /app_complete_scan_job/, 'Migration 009 atomic completion');
  mustHave(s.migrations[2], /app_resolve_auth_session/, 'Migration 007 session resolution');
  mustHave(s.migrations[1], /app_consume_oidc_login_state/, 'Migration 006 one-time login');
  mustHave(s.migrations[0], /app_create_scan/, 'Migration 005 scan creation');
  return { webVariables: web.size, workerVariables: worker.size };
}

const actual = validate(sources);
const mutations = [
  ['worker database accidentally uses web role', s => s.workerIaC = s.workerIaC.replace('postgres://cbc_worker@', 'postgres://cbc_app@')],
  ['worker token accidentally uses web identity', s => s.workerIaC = s.workerIaC.replace('value: workerIdentity!.properties.clientId', 'value: webIdentity.properties.clientId')],
  ['web token accidentally uses worker identity', s => s.webIaC = s.webIaC.replace('value: webIdentity!.properties.clientId', 'value: workerIdentity!.properties.clientId')],
  ['web identity mistakenly assigned to worker', s => s.workerIaC = s.workerIaC.replace("'\${workerIdentity!.id}': {}", "'\${webIdentity.id}': {}")],
  ['OIDC state key accidentally becomes plaintext', s => s.webIaC = s.webIaC.replace("secretRef: 'oidc-state-keys'", "value: 'unsafe'")],
  ['provider key accidentally leaks to web', s => s.webIaC = s.webIaC.replace("{ name: 'PORT', value: '3000' }", "{ name: 'CBC_WEB_RISK_API_KEY', value: 'unsafe' }")],
  ['worker secret accidentally becomes plaintext', s => s.workerIaC = s.workerIaC.replace("secretRef: 'web-risk-key'", "value: 'unsafe'")],
  ['worker token provider falls back to web identity', s => s.workerPg = s.workerPg.replace('AZURE_CLIENT_ID: env.CBC_WORKER_AZURE_CLIENT_ID', 'AZURE_CLIENT_ID: env.AZURE_CLIENT_ID')],
  ['worker image accidentally uses mutable tag', s => s.workerIaC = s.workerIaC.replace('cbc-azure-worker@sha256:', 'cbc-azure-worker:latest')],
  ['worker runtime accidentally accepts web role', s => s.workerRuntime = s.workerRuntime.replace('config.user === "cbc_worker"', 'config.user === "cbc_app"')],
];
for (const [name, mutate] of mutations) {
  const altered = { ...sources };
  mutate(altered);
  assert.ok(Object.keys(sources).some(k => altered[k] !== sources[k]), 'Mutation must change source: ' + name);
  assert.throws(() => validate(altered), undefined, 'Contract regression escaped: ' + name);
}
console.log('Azure clean-start deployment contracts passed: ' + actual.webVariables +
  ' web and ' + actual.workerVariables + ' worker env bindings, 10 detected regressions; offline only');
