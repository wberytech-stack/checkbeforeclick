// Validate compiled ARM JSON, not only Bicep source text.
// This script never authenticates to Azure or makes cloud/provider requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const resourceList = (template) => {
  const { resources } = template;
  assert.ok(resources && typeof resources === 'object', 'Compiled ARM resources must exist');
  return Array.isArray(resources) ? resources : Object.values(resources);
};

const paramDefault = (template, name, expected) => {
  assert.ok(Object.hasOwn(template.parameters ?? {}, name), 'Missing parameter ' + name);
  assert.equal(template.parameters[name].defaultValue, expected, name + ' must default to ' + JSON.stringify(expected));
};

const requireExactTypes = (resources, expected) => {
  const actual = resources.map((r) => r.type).sort();
  assert.deepEqual(actual, [...expected].sort(), 'Compiled resource types/count changed; inspect before deployment');
};

const expandCondition = (condition, variables = {}) => {
  if (typeof condition !== 'string') return '';
  return condition.replace(/variables\('([^']+)'\)/g, (_, key) =>
    typeof variables[key] === 'string' ? variables[key] : 'UNRESOLVED_VARIABLE');
};

const isGuarded = (condition, parameter, variables = {}) =>
  expandCondition(condition, variables).includes("parameters('" + parameter + "')");

const findNamed = (obj, key, value, found = []) => {
  if (!obj || typeof obj !== 'object') return found;
  if (obj[key] === value) found.push(obj);
  for (const item of Object.values(obj)) findNamed(item, key, value, found);
  return found;
};

function validate(template, kind) {
  assert.ok(template && typeof template === 'object', 'Expected compiled ARM JSON object');
  assert.ok(typeof template.$schema === 'string' && template.$schema.includes('deploymentTemplate'), 'Not an ARM deployment template');
  const resources = resourceList(template);
  assert.equal(resources.length, 4, 'Expected one app/job, one identity and two scoped grants');
  const identity = 'Microsoft.ManagedIdentity/userAssignedIdentities';
  const grant = 'Microsoft.Authorization/roleAssignments';
  const app = kind === 'web' ? 'Microsoft.App/containerApps' : 'Microsoft.App/jobs';
  requireExactTypes(resources, [identity, grant, grant, app]);
  const gate = kind === 'web' ? 'deployWeb' : 'deployWorker';
  paramDefault(template, gate, false);
  if (kind === 'web') paramDefault(template, 'minReplicas', 0);
  else paramDefault(template, 'allowPaidProvider', false);
  const vars = template.variables ?? {};
  for (const resource of resources) {
    assert.ok(isGuarded(resource.condition, gate, vars), 'Resource ' + resource.type + ' is not guarded by ' + gate);
    if (kind === 'worker') {
      assert.ok(isGuarded(resource.condition, 'allowPaidProvider', vars), resource.type + ' can deploy without paid-provider opt-in');
      const expression = expandCondition(resource.condition, vars);
      assert.match(expression, /\band\(/, 'Worker must require both approvals simultaneously');
      assert.doesNotMatch(expression, /\bor\(/, 'Worker must never use OR for paid-provider opt-in');
    }
  }
  const grants = resources.filter((r) => r.type === grant);
  assert.ok(grants.every((r) => typeof r.scope === 'string'), 'Role assignments must have explicit scopes');
  assert.ok(grants.some((r) => /registries/i.test(r.scope)), 'Missing registry-scoped ACR grant');
  assert.ok(grants.some((r) => /vaults\/secrets|secrets\//i.test(r.scope)), 'Missing secret-scoped Key Vault grant');
  assert.ok(grants.every((r) => !/vaults\/(?!secrets)/i.test(r.scope) || /secrets/i.test(r.scope)), 'Vault-wide access is forbidden');
  const runtime = resources.find((r) => r.type === app);
  assert.ok(runtime, 'Missing runtime');
  const serialized = JSON.stringify(runtime);
  assert.match(serialized, /@sha256:/, 'Runtime image must use immutable manifest digest');
  assert.doesNotMatch(serialized, /SUPABASE_|INNGEST_|SERVICE_ROLE_KEY|:latest/i, 'Legacy or mutable runtime configuration');
  if (kind === 'web') {
    const ingress = runtime.properties?.configuration?.ingress;
    assert.equal(ingress?.allowInsecure, false, 'Web ingress must require HTTPS');
    assert.equal(ingress?.external, true, 'Web ingress expected to be external');
    assert.equal(runtime.properties?.template?.scale?.maxReplicas, 1, 'Web replicas must be bounded');
    assert.equal(findNamed(runtime, 'name', 'CBC_DATABASE_AUTH').length, 1, 'Web must select managed-identity DB auth');
    assert.equal(findNamed(runtime, 'name', 'CBC_WEB_RISK_API_KEY').length, 0, 'Web must not receive provider key');
  } else {
    const config = runtime.properties?.configuration;
    assert.equal(config?.triggerType, 'Schedule', 'Worker must be scheduled');
    assert.equal(config?.scheduleTriggerConfig?.parallelism, 1, 'Worker must run one parallel replica');
    assert.equal(config?.scheduleTriggerConfig?.replicaCompletionCount, 1, 'Worker must require one completion');
    assert.equal(config?.replicaTimeout, 180, 'Worker timeout must be bounded');
    assert.equal(config?.replicaRetryLimit, 0, 'Worker platform retries must be disabled');
    assert.equal(findNamed(runtime, 'name', 'CBC_WEB_RISK_API_KEY').length, 1, 'Worker must receive only its secret reference');
    assert.equal(findNamed(runtime, 'name', 'CBC_WORKER_DATABASE_URL').length, 1, 'Worker DB role must be explicit');
    assert.equal(findNamed(runtime, 'name', 'CBC_DATABASE_URL').length, 0, 'Worker must not use web DB role');
  }
  return resources.length;
}

if (process.argv[2] === '--self-test') {
  const grant = (scope) => ({ type: 'Microsoft.Authorization/roleAssignments', condition: "[parameters('deployWeb')]", scope });
  const base = {
    $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
    parameters: { deployWeb: { defaultValue: false }, minReplicas: { defaultValue: 0 } },
    resources: [
      { type: 'Microsoft.ManagedIdentity/userAssignedIdentities', condition: "[parameters('deployWeb')]" },
      grant("[resourceId('Microsoft.ContainerRegistry/registries','registry') ]"),
      grant("[resourceId('Microsoft.KeyVault/vaults/secrets','vault','secret') ]"),
      { type: 'Microsoft.App/containerApps', condition: "[parameters('deployWeb')]", properties: {
        configuration: { ingress: { external: true, allowInsecure: false } },
        template: { scale: { maxReplicas: 1 }, containers: [{ image: 'repo@sha256:abc', env: [{ name: 'CBC_DATABASE_AUTH', value: 'entra' }] }] },
      } },
    ],
  };
  assert.equal(validate(base, 'web'), 4);
  const mutate = (fn) => { const copy = structuredClone(base); fn(copy); assert.throws(() => validate(copy, 'web')); };
  mutate((t) => { t.parameters.deployWeb.defaultValue = true; });
  mutate((t) => { delete t.resources[0].condition; });
  mutate((t) => { t.resources[2].scope = "[resourceId('Microsoft.KeyVault/vaults','vault')]"; });
  mutate((t) => { t.resources[3].properties.configuration.ingress.allowInsecure = true; });
  mutate((t) => { t.resources[3].properties.template.containers[0].image = 'repo:latest'; });
  mutate((t) => { t.resources[3].properties.template.containers[0].env.push({ name: 'SUPABASE_SERVICE_ROLE_KEY' }); });
  const worker = structuredClone(base);
  worker.parameters = { deployWorker: { defaultValue: false }, allowPaidProvider: { defaultValue: false } };
  worker.variables = { enableJob: "[and(parameters('deployWorker'), parameters('allowPaidProvider'))]" };
  for (const resource of worker.resources) resource.condition = "[variables('enableJob')]";
  worker.resources[3].type = 'Microsoft.App/jobs';
  worker.resources[3].properties = {
    configuration: { triggerType: 'Schedule', scheduleTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }, replicaTimeout: 180, replicaRetryLimit: 0 },
    template: { containers: [{ image: 'repo@sha256:abc', env: [{ name: 'CBC_WEB_RISK_API_KEY', secretRef: 'web-risk-key' }, { name: 'CBC_WORKER_DATABASE_URL', value: 'postgres://cbc_worker@localhost:5432/cbc' }] }] },
  };
  assert.equal(validate(worker, 'worker'), 4);
  const mutateWorker = (fn) => { const copy = structuredClone(worker); fn(copy); assert.throws(() => validate(copy, 'worker')); };
  mutateWorker((t) => { t.parameters.allowPaidProvider.defaultValue = true; });
  mutateWorker((t) => { t.variables.enableJob = "[or(parameters('deployWorker'), parameters('allowPaidProvider'))]"; });
  mutateWorker((t) => { t.resources[3].properties.configuration.replicaRetryLimit = 10; });
  mutateWorker((t) => { t.resources[3].properties.configuration.scheduleTriggerConfig.parallelism = 2; });
  console.log('Compiled ARM contract: 2 positive fixtures and 10 negative mutations passed (offline)');
} else {
  assert.equal(process.argv.length, 4, 'Usage: node validate-compiled-iac.mjs <web.json> <worker.json>');
  const web = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const worker = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  validate(web, 'web');
  validate(worker, 'worker');
  console.log('Compiled Azure web and worker ARM contracts passed (8 guarded resources, no Azure calls)');
}
