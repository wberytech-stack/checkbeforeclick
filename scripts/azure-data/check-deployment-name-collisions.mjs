// Offline preflight for CBC deployment names. Never contacts Azure or reads secrets.
// Usage: node scripts/azure-data/check-deployment-name-collisions.mjs planned.json inventory.json
// Both inputs are JSON: {"resources":[{"type":"Microsoft.App/containerApps","name":"..."}]}.
// Inventory must come from an authenticated read-only Azure export before deployment.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const normalize = s => s.trim().toLowerCase();
const key = r => normalize(r.type) + '/' + normalize(r.name);
const types = new Set([
  'microsoft.app/containerapps', 'microsoft.app/jobs',
  'microsoft.app/managedenvironments', 'microsoft.managedidentity/userassignedidentities',
  'microsoft.containerregistry/registries', 'microsoft.keyvault/vaults',
  'microsoft.dbforpostgresql/flexibleservers',
]);
const protectedExisting = [
  ['Microsoft.App/containerApps','ca-cbc-web-stg-cc-001'],
  ['Microsoft.App/managedEnvironments','cae-cbc-prod-cc-001'],
  ['Microsoft.ContainerRegistry/registries','crcbcprodcc001'],
  ['Microsoft.KeyVault/vaults','kv-cbc-prod-cc-001'],
  ['Microsoft.DBforPostgreSQL/flexibleServers','pg-cbc-prod-cc-001'],
  ['Microsoft.ManagedIdentity/userAssignedIdentities','id-cbc-web-cc-001'],
  ['Microsoft.ManagedIdentity/userAssignedIdentities','id-cbc-deploy-cc-001'],
].map(([type,name]) => ({type,name}));

function validateList(input, label) {
  assert.ok(input && Array.isArray(input.resources), label + ': resources array required');
  const seen = new Set();
  for (const r of input.resources) {
    assert.ok(r && typeof r.type === 'string' && typeof r.name === 'string' &&
      r.type.trim() && r.name.trim(), label + ': type and name required');
    assert.ok(types.has(normalize(r.type)), label + ': unsupported resource type ' + r.type);
    assert.ok(!r.name.includes('/') && !r.name.includes('\\'), label + ': resource name only, not an ID');
    assert.ok(!seen.has(key(r)), label + ': duplicate ' + key(r));
    seen.add(key(r));
  }
  return seen;
}

export function check(planned, inventory) {
  const plan = validateList(planned, 'planned');
  const existing = validateList(inventory, 'inventory');
  const protectedNames = new Set(protectedExisting.map(key));
  const collisions = [...plan].filter(k => existing.has(k) || protectedNames.has(k));
  assert.deepEqual(collisions, [], 'Refusing to create/overwrite existing CBC resource names');
  return { planned: plan.size, inventoried: existing.size };
}

if (process.argv.includes('--self-test')) {
  const sample = {resources:[{type:'Microsoft.App/containerApps',name:'ca-cbc-web-azure-001'}]};
  assert.deepEqual(check(sample,{resources:[]}),{planned:1,inventoried:0});
  assert.throws(()=>check(sample,sample),/Refusing/);
  assert.throws(()=>check({resources:[protectedExisting[0]]},{resources:[]}),/Refusing/);
  assert.throws(()=>check({resources:[protectedExisting[5]]},{resources:[]}),/Refusing/);
  assert.throws(()=>check({resources:[...sample.resources,...sample.resources]},{resources:[]}),/duplicate/);
  assert.throws(()=>check({resources:[{type:'other',name:'x'}]},{resources:[]}),/unsupported/);
  assert.throws(()=>check({resources:[{type:'Microsoft.App/jobs',name:'../foo'}]},{resources:[]}),/resource name only/);
  console.log('CBC deployment collision preflight: 7 offline checks passed');
} else {
  assert.equal(process.argv.length,4,'Usage: node check-deployment-name-collisions.mjs planned.json inventory.json');
  const result = check(JSON.parse(readFileSync(process.argv[2],'utf8')),
    JSON.parse(readFileSync(process.argv[3],'utf8')));
  console.log('No name collisions:',result.planned,'planned resources against',result.inventoried,'inventory entries');
}
