// Gate 006B - Phase 1 Azure hosting for CheckBeforeClick (Gate 006A section 3).
//
// AUTHORED ONLY. Agents never compile against Azure, apply, or deploy this
// (AGENTS.md section 20). The founder runs, in the existing resource group:
//   az deployment group what-if --resource-group rg-cbc-prod-canadacentral-001 \
//     --template-file infra/azure/hosting/main.bicep \
//     --parameters infra/azure/hosting/main.parameters.json
// and applies only after reviewing the what-if output.
//
// Two phases (the app image listens on 3000 and is probed on /api/healthz, so the
// apps are only created once a real cbc-web image exists in the registry):
//   Phase A: deployApps=false -> identity, registry, Log Analytics, environment,
//            AcrPull + Key Vault Secrets User role assignments.
//   Phase B: after the first image is pushed (runbook), deployApps=true with
//            stagingImage / productionImage set to <registry>/cbc-web:<sha>-<env>.
//
// Prerequisites for Phase B (founder): the Key Vault secrets named in the
// parameters file exist; otherwise Container Apps cannot resolve the references.
// No secret VALUE appears in this template or its parameters.

targetScope = 'resourceGroup'

param location string = resourceGroup().location

@description('Existing Key Vault (kv-cbc-prod-cc-001). Only an access role is added.')
param keyVaultName string

param registryName string
param logAnalyticsName string
param environmentName string
param identityName string
param stagingAppName string
param productionAppName string

@description('Phase B switch: create the two Container Apps (requires images in the registry).')
param deployApps bool = false

@description('Phase B: full image ref for staging, e.g. crcbcprodcc001.azurecr.io/cbc-web:<sha>-stg')
param stagingImage string = ''

@description('Phase B: full image ref for production, e.g. crcbcprodcc001.azurecr.io/cbc-web:<sha>-prod')
param productionImage string = ''

@description('Log Analytics daily ingestion cap in GB (cost guardrail).')
param logDailyQuotaGb string = '0.5'

param stagingSecretNames object
param productionSecretNames object
param stagingPlainEnv array
param productionPlainEnv array

param tags object = {
  project: 'checkbeforeclick'
  gate: '006B'
}

// Built-in role definition ids (verify in what-if output).
var roleAcrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var roleKeyVaultSecretsUser = '4633458b-17de-408a-b874-0445c86b69e6'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: identityName
  location: location
  tags: tags
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: logAnalyticsName
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json(logDailyQuotaGb)
    }
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: environmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, roleAcrPull)
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleAcrPull)
  }
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, identity.id, roleKeyVaultSecretsUser)
  scope: keyVault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleKeyVaultSecretsUser)
  }
}

module staging 'modules/web-app.bicep' = if (deployApps) {
  name: 'web-staging'
  dependsOn: [
    acrPull
    kvSecretsUser
  ]
  params: {
    name: stagingAppName
    location: location
    environmentId: env.id
    identityId: identity.id
    registryServer: registry.properties.loginServer
    image: stagingImage
    keyVaultUri: keyVault.properties.vaultUri
    secretNames: stagingSecretNames
    plainEnv: stagingPlainEnv
    minReplicas: 0
    maxReplicas: 1
    tags: union(tags, { environment: 'staging' })
  }
}

module production 'modules/web-app.bicep' = if (deployApps) {
  name: 'web-production'
  dependsOn: [
    acrPull
    kvSecretsUser
  ]
  params: {
    name: productionAppName
    location: location
    environmentId: env.id
    identityId: identity.id
    registryServer: registry.properties.loginServer
    image: productionImage
    keyVaultUri: keyVault.properties.vaultUri
    secretNames: productionSecretNames
    plainEnv: productionPlainEnv
    minReplicas: 1
    maxReplicas: 3
    tags: union(tags, { environment: 'production' })
  }
}

output registryLoginServer string = registry.properties.loginServer
output identityClientId string = identity.properties.clientId
// Known after Phase A; set CBC_STG_NEXT_PUBLIC_APP_URL to this before the first staging build.
output stagingPublicOrigin string = 'https://${stagingAppName}.${env.properties.defaultDomain}'
output stagingFqdn string = deployApps ? staging!.outputs.fqdn : ''
output productionFqdn string = deployApps ? production!.outputs.fqdn : ''
