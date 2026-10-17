// Gate 006B - one CheckBeforeClick web Container App (used for staging and production).
// AUTHORED ONLY. Not compiled or deployed by agents (AGENTS.md section 20).
// The founder validates with `az deployment group what-if` before any apply.

@description('Container App name, e.g. ca-cbc-web-prod-cc-001')
param name string

param location string

@description('Resource id of the Container Apps managed environment')
param environmentId string

@description('Resource id of the user-assigned identity (AcrPull + Key Vault Secrets User)')
param identityId string

@description('Registry login server, e.g. crcbcprodcc001.azurecr.io')
param registryServer string

@description('Image ref <registry>/cbc-web:<sha>-<env>. Later deploys change it via azure-deploy.yml.')
param image string

@description('Key Vault URI, e.g. https://kv-cbc-prod-cc-001.vault.azure.net/')
param keyVaultUri string

@description('Key Vault secret NAMES (never values) for this environment')
param secretNames object

@description('Plain (non-secret) environment variables for this environment')
param plainEnv array

@description('Minimum replicas: 0 allows scale to zero (staging; production before cutover), 1 keeps one replica running.')
@minValue(0)
@maxValue(1)
param minReplicas int

@minValue(1)
param maxReplicas int

param tags object

var secretMap = [
  { name: 'supabase-service-role-key', vaultKey: 'supabaseServiceRoleKey', envName: 'SUPABASE_SERVICE_ROLE_KEY' }
  { name: 'google-web-risk-api-key', vaultKey: 'googleWebRiskApiKey', envName: 'GOOGLE_WEB_RISK_API_KEY' }
  { name: 'inngest-event-key', vaultKey: 'inngestEventKey', envName: 'INNGEST_EVENT_KEY' }
  { name: 'inngest-signing-key', vaultKey: 'inngestSigningKey', envName: 'INNGEST_SIGNING_KEY' }
]

// Bicep allows for-expressions only as declaration or property values, not as
// function arguments (BCP138), so the secret env list is built here and then
// passed to concat() below.
var secretEnv = [for s in secretMap: {
  name: s.envName
  secretRef: s.name
}]

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    managedEnvironmentId: environmentId
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: registryServer
          identity: identityId
        }
      ]
      secrets: [for s in secretMap: {
        name: s.name
        keyVaultUrl: '${keyVaultUri}secrets/${secretNames[s.vaultKey]}'
        identity: identityId
      }]
    }
    template: {
      containers: [
        {
          name: 'web'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          // PORT/HOSTNAME repeat the image defaults explicitly so a platform-injected
          // HOSTNAME (the replica name) can never make Next bind to one interface.
          env: concat(
            secretEnv,
            [
              { name: 'PORT', value: '3000' }
              { name: 'HOSTNAME', value: '0.0.0.0' }
            ],
            plainEnv
          )
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/api/healthz'
                port: 3000
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/api/healthz'
                port: 3000
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output fqdn string = app.properties.configuration.ingress.fqdn
output name string = app.name
