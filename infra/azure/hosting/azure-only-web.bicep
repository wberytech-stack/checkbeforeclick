// Clean Azure-only CheckBeforeClick web deployment. Draft IaC: NEVER apply automatically.
// Independent of legacy Supabase/Vercel/Inngest hosting resources and credentials.
// Existing environment/registry/vault are referenced, not created or reconfigured.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param environmentName string
param registryName string
param keyVaultName string
param webIdentityName string
param webAppName string
param databaseHost string
param databaseName string
param publicOrigin string
param oidcIssuer string
param oidcClientId string
param oidcStateActiveKid string
param oidcStateSecretName string

// Immutable manifest digest from the approved Azure-only Dockerfile build.
@minLength(64)
@maxLength(64)
param webImageSha256 string

// Both deployment and always-on billing require separate founder decisions.
param deployWeb bool = false
@allowed([
  0
  1
])
param minReplicas int = 0

var acrPullRole = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var kvSecretsUserRole = '4633458b-17de-408a-b874-0445c86b69e6'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}
resource stateSecret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' existing = {
  parent: vault
  name: oidcStateSecretName
}

// Fresh web-only identity: do not reuse the legacy vault-wide hosting identity
// or the independently restricted scan-worker identity.
resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (deployWeb) {
  name: webIdentityName
  location: location
  tags: {
    project: 'checkbeforeclick'
    component: 'azure-web'
  }
}
resource webAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWeb) {
  name: guid(registry.id, webIdentity!.id, acrPullRole)
  scope: registry
  properties: {
    principalId: webIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRole)
  }
}
resource webStateSecretRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployWeb) {
  name: guid(stateSecret.id, webIdentity!.id, kvSecretsUserRole)
  scope: stateSecret
  properties: {
    principalId: webIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', kvSecretsUserRole)
  }
}

// Only the new Azure web image is eligible. No Supabase or Inngest credentials
// or paid threat-provider key can reach this container through the template.
resource web 'Microsoft.App/containerApps@2024-03-01' = if (deployWeb) {
  name: webAppName
  location: location
  tags: {
    project: 'checkbeforeclick'
    component: 'azure-web'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${webIdentity!.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
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
          server: registry.properties.loginServer
          identity: webIdentity!.id
        }
      ]
      secrets: [
        {
          name: 'oidc-state-keys'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/${oidcStateSecretName}'
          identity: webIdentity!.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'azure-web'
          image: '${registry.properties.loginServer}/cbc-azure-web@sha256:${webImageSha256}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: [
            { name: 'CBC_AZURE_ONLY_MODE', value: '1' }
            { name: 'CBC_AZURE_PUBLIC_ORIGIN', value: publicOrigin }
            { name: 'CBC_AZURE_OIDC_ISSUER', value: oidcIssuer }
            { name: 'CBC_AZURE_OIDC_CLIENT_ID', value: oidcClientId }
            { name: 'CBC_AZURE_OIDC_STATE_ACTIVE_KID', value: oidcStateActiveKid }
            { name: 'CBC_AZURE_OIDC_STATE_KEYS', secretRef: 'oidc-state-keys' }
            { name: 'CBC_DATABASE_URL', value: 'postgres://cbc_app@${databaseHost}:5432/${databaseName}' }
            { name: 'CBC_DATABASE_AUTH', value: 'entra' }
            { name: 'AZURE_CLIENT_ID', value: webIdentity!.properties.clientId }
            { name: 'PORT', value: '3000' }
            { name: 'HOSTNAME', value: '0.0.0.0' }
          ]
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
        maxReplicas: 1
      }
    }
  }
  dependsOn: [
    webAcrPull
    webStateSecretRead
  ]
}

output webEnabled bool = deployWeb
output webFqdn string = deployWeb ? web!.properties.configuration.ingress.fqdn : ''
