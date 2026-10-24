// Gate 006C - staging-only Phase B entry point, applied by azure-deploy.yml (environment
// staging) after a checked what-if and the founder's azure-staging approval.
//
// It creates or updates exactly one resource, the staging Container App, through the
// same web-app.bicep module as main.bicep. Everything else is referenced as existing,
// so the deploying identity needs no role-assignment rights and cannot reach production.
// Names and staging values come from main.parameters.json (single source of truth).
// Registry and Key Vault addresses are derived from their names, not read with
// reference(): what-if cannot evaluate references to resources outside the template, and
// the guard needs every secret's Key Vault URL as a concrete value.

targetScope = 'resourceGroup'

@description('Exact image reference by digest, <registry>/cbc-web@sha256:<64 hex>, pushed by the same workflow run')
param image string

var cfg = loadJsonContent('main.parameters.json').parameters

resource env 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: cfg.environmentName.value
}

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: cfg.identityName.value
}

module staging 'modules/web-app.bicep' = {
  name: 'web-staging'
  params: {
    name: cfg.stagingAppName.value
    location: resourceGroup().location
    environmentId: env.id
    identityId: identity.id
    registryServer: '${cfg.registryName.value}${environment().suffixes.acrLoginServer}'
    image: image
    keyVaultUri: 'https://${cfg.keyVaultName.value}${environment().suffixes.keyvaultDns}/'
    secretNames: cfg.stagingSecretNames.value
    plainEnv: cfg.stagingPlainEnv.value
    // Fixed here: staging never receives the Web Risk key (Gate 006C).
    injectWebRiskKey: false
    minReplicas: 0
    maxReplicas: 1
    tags: {
      project: 'checkbeforeclick'
      gate: '006B'
      environment: 'staging'
    }
  }
}

output stagingFqdn string = staging.outputs.fqdn
