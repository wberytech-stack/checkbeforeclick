// Draft only: dedicated scheduled Azure Container Apps URL worker.
// NO resource is created unless both deployWorker and allowPaidProvider are true.
// Founder must approve an Azure what-if, resource creation, provider billing,
// managed-identity PostgreSQL grants, secrets and deployment separately.
// This is deliberately independent of the legacy Supabase/Inngest hosting IaC.
targetScope = 'resourceGroup'

param location string = resourceGroup().location
param environmentName string
param registryName string
param keyVaultName string
param webIdentityName string
param workerIdentityName string
param workerJobName string
param databaseHost string
param databaseName string
param webRiskSecretName string

// Supply an immutable SHA-256 manifest digest, never a mutable tag.
@minLength(64)
@maxLength(64)
param workerImageSha256 string

// Explicit double opt-in: scheduled executions and Web Risk requests may cost money.
param deployWorker bool = false
param allowPaidProvider bool = false

@allowed([
  '*/5 * * * *'
  '*/15 * * * *'
  '0 * * * *'
])
param scheduleCron string = '*/5 * * * *'

var enableJob = deployWorker && allowPaidProvider
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var roleKeyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' existing = {
  name: environmentName
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource webIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: webIdentityName
}

// Worker identity must be distinct from the web identity. The runtime also
// compares both client IDs and refuses to run if they match.
resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = if (enableJob) {
  name: workerIdentityName
  location: location
  tags: {
    project: 'checkbeforeclick'
    component: 'url-worker'
  }
}

resource workerAcrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableJob) {
  name: guid(registry.id, workerIdentity!.id, roleAcrPull)
  scope: registry
  properties: {
    principalId: workerIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
  }
}

resource workerVaultRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (enableJob) {
  name: guid(vault.id, workerIdentity!.id, roleKeyVaultSecretsUser)
  scope: vault
  properties: {
    principalId: workerIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKeyVaultSecretsUser)
  }
}

// No ingress, no web credentials, no admin database password. The worker
// obtains its own short-lived Entra PostgreSQL token at runtime.
resource job 'Microsoft.App/jobs@2024-03-01' = if (enableJob) {
  name: workerJobName
  location: location
  tags: {
    project: 'checkbeforeclick'
    component: 'url-worker'
  }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workerIdentity!.id}': {}
    }
  }
  properties: {
    environmentId: environment.id
    configuration: {
      triggerType: 'Schedule'
      scheduleTriggerConfig: {
        cronExpression: scheduleCron
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 180
      replicaRetryLimit: 0
      registries: [
        {
          server: registry.properties.loginServer
          identity: workerIdentity!.id
        }
      ]
      secrets: [
        {
          name: 'web-risk-key'
          keyVaultUrl: '${vault.properties.vaultUri}secrets/${webRiskSecretName}'
          identity: workerIdentity!.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'url-worker'
          image: '${registry.properties.loginServer}/cbc-azure-worker@sha256:${workerImageSha256}'
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
          env: [
            {
              name: 'CBC_WORKER_DATABASE_URL'
              value: 'postgres://cbc_worker@${databaseHost}:5432/${databaseName}'
            }
            {
              name: 'CBC_WORKER_AZURE_CLIENT_ID'
              value: workerIdentity!.properties.clientId
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: webIdentity.properties.clientId
            }
            {
              name: 'CBC_WEB_RISK_API_KEY'
              secretRef: 'web-risk-key'
            }
          ]
        }
      ]
    }
  }
  dependsOn: [
    workerAcrPull
    workerVaultRead
  ]
}

output workerJobEnabled bool = enableJob
output workerJobName string = enableJob ? job!.name : ''
