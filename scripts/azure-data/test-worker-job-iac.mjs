// Offline, zero-cloud checks for the opt-in Container Apps scheduled worker.
// These guard invariants, not Bicep compilation or actual Azure permissions.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../infra/azure/hosting/azure-url-worker-job.bicep', import.meta.url), 'utf8');

const checks = [
  ['resource-group only', /targetScope\s*=\s*'resourceGroup'/],
  ['worker opt-in defaults off', /param deployWorker bool = false/],
  ['paid-provider opt-in defaults off', /param allowPaidProvider bool = false/],
  ['both opt-ins required', /var enableJob = deployWorker && allowPaidProvider/],
  ['job conditionally provisioned', /resource job 'Microsoft\.App\/jobs@[^']+' = if \(enableJob\)/],
  ['identity conditionally provisioned', /resource workerIdentity 'Microsoft\.ManagedIdentity\/userAssignedIdentities@[^']+' = if \(enableJob\)/],
  ['registry grant conditionally provisioned', /resource workerAcrPull 'Microsoft\.Authorization\/roleAssignments@[^']+' = if \(enableJob\)/],
  ['vault grant conditionally provisioned', /resource workerVaultRead 'Microsoft\.Authorization\/roleAssignments@[^']+' = if \(enableJob\)/],
  ['registry scope limited', /scope: registry/],
  ['single-secret RBAC scope', /resource providerSecret 'Microsoft\.KeyVault\/vaults\/secrets@[^']+' existing = \{[\s\S]*?parent: vault[\s\S]*?name: webRiskSecretName[\s\S]*?\}/],
  ['vault grant uses only provider secret', /name: guid\(providerSecret\.id, workerIdentity!\.id, roleKeyVaultSecretsUser\)\s+scope: providerSecret/],
  ['web identity only referenced', /resource webIdentity 'Microsoft\.ManagedIdentity\/userAssignedIdentities@[^']+' existing =/],
  ['separate worker identity assigned', /userAssignedIdentities:\s*\{\s*'\$\{workerIdentity!\.id\}': \{\}/],
  ['worker identity used for registry', /server: registry\.properties\.loginServer\s+identity: workerIdentity!\.id/],
  ['worker identity used for Key Vault', /keyVaultUrl: '\$\{vault\.properties\.vaultUri\}secrets\/\$\{webRiskSecretName\}'\s+identity: workerIdentity!\.id/],
  ['image digest length constrained', /@minLength\(64\)\s+@maxLength\(64\)\s+param workerImageSha256 string/],
  ['immutable image digest', /image: '\$\{registry\.properties\.loginServer\}\/cbc-azure-worker@sha256:\$\{workerImageSha256\}'/],
  ['scheduled not event or manual', /triggerType: 'Schedule'/],
  ['bounded cron choices', /'\*\/5 \* \* \* \*'[\s\S]*'\*\/15 \* \* \* \*'[\s\S]*'0 \* \* \* \*'/],
  ['single parallel replica', /parallelism: 1/],
  ['single successful completion', /replicaCompletionCount: 1/],
  ['bounded platform timeout', /replicaTimeout: 180/],
  ['no automatic platform retries', /replicaRetryLimit: 0/],
  ['worker-only database role', /value: 'postgres:\/\/cbc_worker@\$\{databaseHost\}:5432\/\$\{databaseName\}'/],
  ['worker client ID passed', /name: 'CBC_WORKER_AZURE_CLIENT_ID'\s+value: workerIdentity!\.properties\.clientId/],
  ['web client ID passed for separation check', /name: 'AZURE_CLIENT_ID'\s+value: webIdentity\.properties\.clientId/],
  ['provider key injected only as secret reference', /name: 'CBC_WEB_RISK_API_KEY'\s+secretRef: 'web-risk-key'/],
  ['no HTTP ingress', /resource job[\s\S]*template:\s*\{\s*containers:/],
  ['no web or legacy provider environment credentials', /name: 'CBC_WORKER_DATABASE_URL'/],
];

function failedChecks(s) {
  return checks.filter(([, pattern]) => !pattern.test(s)).map(([name]) => name);
}
assert.deepEqual(failedChecks(source), [], 'Worker IaC contract must pass every guard');
assert.doesNotMatch(source, /\bingress\s*:/, 'Worker must have no ingress');
assert.doesNotMatch(source, /\b(password|adminUserEnabled|SUPABASE_SERVICE_ROLE_KEY|INNGEST_SIGNING_KEY)\s*:/, 'No legacy or password secrets');
assert.doesNotMatch(source, /name: 'CBC_WEB_RISK_API_KEY'\s+value:/, 'Provider key must not be plain text');

const mutations = [
  ['accidental worker provisioning', s => s.replace('param deployWorker bool = false', 'param deployWorker bool = true')],
  ['accidental paid calls', s => s.replace('param allowPaidProvider bool = false', 'param allowPaidProvider bool = true')],
  ['weakened double opt-in', s => s.replace('deployWorker && allowPaidProvider', 'deployWorker || allowPaidProvider')],
  ['unconditional job', s => s.replace("resource job 'Microsoft.App/jobs@2024-03-01' = if (enableJob)", "resource job 'Microsoft.App/jobs@2024-03-01' =")],
  ['vault-wide secret access', s => s.replace('scope: providerSecret', 'scope: vault')],
  ['wrong registry identity', s => s.replace('identity: workerIdentity!.id', 'identity: webIdentity.id')],
  ['mutable image', s => s.replace('cbc-azure-worker@sha256:', 'cbc-azure-worker:latest')],
  ['parallel provider requests', s => s.replace('parallelism: 1', 'parallelism: 5')],
  ['unbounded retry charges', s => s.replace('replicaRetryLimit: 0', 'replicaRetryLimit: 10')],
  ['provider key plain text', s => s.replace("secretRef: 'web-risk-key'", "value: 'hardcoded'")],
];
for (const [name, mutate] of mutations) {
  const altered = mutate(source);
  assert.notEqual(altered, source, 'Mutation must modify source: ' + name);
  const detected = failedChecks(altered).length > 0 ||
    /name: 'CBC_WEB_RISK_API_KEY'\s+value:/.test(altered);
  assert.ok(detected, 'Safety regression escaped guards: ' + name);
}
console.log('Azure worker IaC: ' + (checks.length + 3) + ' checks passed; ' + mutations.length + ' safety mutations detected; 0 Azure calls');
