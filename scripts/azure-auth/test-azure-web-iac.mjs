// Offline regression checks for the Azure-only web deployment contract.
// No Azure CLI, network, secrets, provider calls or resource provisioning.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../infra/azure/hosting/azure-only-web.bicep', import.meta.url), 'utf8');
const guards = [
  ['resource-group template', /targetScope\s*=\s*'resourceGroup'/],
  ['deployment disabled by default', /param deployWeb bool = false/],
  ['scale-to-zero default', /param minReplicas int = 0/],
  ['only 0 or 1 minimum replicas', /@allowed\(\[\s*0\s+1\s*\]\)\s+param minReplicas/],
  ['environment existing', /resource environment 'Microsoft\.App\/managedEnvironments@[^']+' existing =/],
  ['registry existing', /resource registry 'Microsoft\.ContainerRegistry\/registries@[^']+' existing =/],
  ['vault existing', /resource vault 'Microsoft\.KeyVault\/vaults@[^']+' existing =/],
  ['state secret existing', /resource stateSecret 'Microsoft\.KeyVault\/vaults\/secrets@[^']+' existing =/],
  ['web identity opt-in', /resource webIdentity 'Microsoft\.ManagedIdentity\/userAssignedIdentities@[^']+' = if \(deployWeb\)/],
  ['ACR role opt-in', /resource webAcrPull 'Microsoft\.Authorization\/roleAssignments@[^']+' = if \(deployWeb\)/],
  ['state secret grant opt-in', /resource webStateSecretRead 'Microsoft\.Authorization\/roleAssignments@[^']+' = if \(deployWeb\)/],
  ['app opt-in', /resource web 'Microsoft\.App\/containerApps@[^']+' = if \(deployWeb\)/],
  ['registry RBAC scoped', /name: guid\(registry\.id, webIdentity!\.id, acrPullRole\)\s+scope: registry/],
  ['secret RBAC scoped', /name: guid\(stateSecret\.id, webIdentity!\.id, kvSecretsUserRole\)\s+scope: stateSecret/],
  ['identity attached to web', /userAssignedIdentities:\s*\{\s*'\$\{webIdentity!\.id\}': \{\}/],
  ['identity pulls image', /server: registry\.properties\.loginServer\s+identity: webIdentity!\.id/],
  ['identity reads secret', /keyVaultUrl: '\$\{vault\.properties\.vaultUri\}secrets\/\$\{oidcStateSecretName\}'\s+identity: webIdentity!\.id/],
  ['immutable digest length', /@minLength\(64\)\s+@maxLength\(64\)\s+param webImageSha256 string/],
  ['Azure-only image digest', /image: '\$\{registry\.properties\.loginServer\}\/cbc-azure-web@sha256:\$\{webImageSha256\}'/],
  ['Azure-only runtime switch', /name: 'CBC_AZURE_ONLY_MODE', value: '1'/],
  ['managed identity database auth', /name: 'CBC_DATABASE_AUTH', value: 'entra'/],
  ['restricted web database role', /name: 'CBC_DATABASE_URL', value: 'postgres:\/\/cbc_app@\$\{databaseHost\}:5432\/\$\{databaseName\}'/],
  ['web identity client ID', /name: 'AZURE_CLIENT_ID', value: webIdentity!\.properties\.clientId/],
  ['OIDC state secret reference', /name: 'CBC_AZURE_OIDC_STATE_KEYS', secretRef: 'oidc-state-keys'/],
  ['public origin explicit', /name: 'CBC_AZURE_PUBLIC_ORIGIN', value: publicOrigin/],
  ['issuer explicit', /name: 'CBC_AZURE_OIDC_ISSUER', value: oidcIssuer/],
  ['client ID explicit', /name: 'CBC_AZURE_OIDC_CLIENT_ID', value: oidcClientId/],
  ['active key ID explicit', /name: 'CBC_AZURE_OIDC_STATE_ACTIVE_KID', value: oidcStateActiveKid/],
  ['no insecure ingress', /allowInsecure: false/],
  ['liveness endpoint', /type: 'Liveness'[\s\S]*?path: '\/api\/healthz'/],
  ['readiness endpoint', /type: 'Readiness'[\s\S]*?path: '\/api\/healthz'/],
  ['bounded max replicas', /maxReplicas: 1/],
];

function violations(text) {
  const missing = guards.filter(([, regex]) => !regex.test(text)).map(([name]) => name);
  if (/scope:\s*vault\b/.test(text)) missing.push('vault-wide access');
  if (/name:\s*'(?:SUPABASE_[A-Z_]+|INNGEST_[A-Z_]+|GOOGLE_WEB_RISK_API_KEY|CBC_WEB_RISK_API_KEY)'/.test(text)) missing.push('legacy/paid provider env');
  if (/name: 'CBC_AZURE_OIDC_STATE_KEYS', value:/.test(text)) missing.push('plain-text OIDC state keys');
  if (/name: 'CBC_DATABASE_URL', secretRef:/.test(text)) missing.push('database must use managed identity');
  if (/image:.*:latest/.test(text)) missing.push('mutable image');
  if (/resource (?:web|webIdentity|webAcrPull|webStateSecretRead) '[^']+' = \{/.test(text)) missing.push('unguarded provision');
  if (/password\s*:|adminUserEnabled\s*:/.test(text)) missing.push('password/admin config');
  return missing;
}
assert.deepEqual(violations(source), [], 'Azure-only web IaC safety contract');
const mutations = [
  ['auto-provision', s => s.replace('param deployWeb bool = false', 'param deployWeb bool = true')],
  ['always-on billing', s => s.replace('param minReplicas int = 0', 'param minReplicas int = 1')],
  ['unguarded web', s => s.replace("resource web 'Microsoft.App/containerApps@2024-03-01' = if (deployWeb)", "resource web 'Microsoft.App/containerApps@2024-03-01' = {")],
  ['vault-wide grant', s => s.replace('scope: stateSecret', 'scope: vault')],
  ['wrong image', s => s.replace('cbc-azure-web@sha256:', 'cbc-azure-web:latest-')],
  ['state key in plain text', s => s.replace("secretRef: 'oidc-state-keys'", "value: 'plaintext'")],
  ['database password auth', s => s.replace("name: 'CBC_DATABASE_AUTH', value: 'entra'", "name: 'CBC_DATABASE_AUTH', value: 'password'")],
  ['insecure ingress', s => s.replace('allowInsecure: false', 'allowInsecure: true')],
  ['legacy credential', s => s.replace("name: 'CBC_AZURE_ONLY_MODE'", "name: 'SUPABASE_SERVICE_ROLE_KEY'")],
  ['bypass web identity', s => s.replace('identity: webIdentity!.id', 'identity: workerIdentity.id')],
];
for (const [name, mutate] of mutations) {
  const changed = mutate(source);
  assert.notEqual(changed, source, 'Mutation must alter source: ' + name);
  assert.notEqual(violations(changed).length, 0, 'Mutation escaped detection: ' + name);
}
console.log('Azure-only web IaC: ' + guards.length + ' contract checks passed; ' + mutations.length + ' safety mutations detected; 0 Azure calls');
