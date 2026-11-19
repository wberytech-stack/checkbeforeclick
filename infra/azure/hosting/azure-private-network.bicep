// Gate 008E (offline design; NOT deployed): private application-to-database path for the clean-start Azure web
// and worker. NO resource is created unless deployNetwork is true, which needs explicit founder approval of a
// reviewed what-if (docs/azure/gate-008e-private-network.md).
//
// Creates, only when deployNetwork = true:
//   - a new virtual network with two subnets: one delegated to Microsoft.App/environments (Container Apps
//     workload-profiles environment) and one for the PostgreSQL private endpoint;
//   - the private DNS zone privatelink.postgres.database.azure.com linked to that network;
//   - a private endpoint to the EXISTING server pg-cbc-prod-cc-001 (groupId postgresqlServer) + DNS zone group;
//   - a NEW Container Apps environment (Consumption workload profile only) in the delegated subnet.
// Never creates or changes: the PostgreSQL server, its databases, firewall rules, settings or administrators; the
// existing environment cae-cbc-prod-cc-001; the legacy staging app; Key Vault; the registry. No firewall rule of any
// kind, no public IP, NAT gateway, peering, gateway or DDoS plan.
targetScope = 'resourceGroup'

param location string = resourceGroup().location

@description('EXISTING PostgreSQL flexible server (public-access mode). Referenced only.')
param postgresServerName string

@description('EXISTING Log Analytics workspace for the new environment logs. Referenced only.')
param logAnalyticsName string

@description('NEW virtual network name.')
param vnetName string

@description('NEW Container Apps environment name (must differ from the existing environment).')
param environmentName string

@description('NEW private endpoint name for PostgreSQL.')
param privateEndpointName string

// RFC 1918 space; no overlap with any existing network (verified by the founder read-only check N3).
param vnetAddressPrefix string = '10.80.0.0/24'
// Workload-profiles environments need at least /27 and the size cannot change later: /25 leaves headroom.
param appsSubnetPrefix string = '10.80.0.0/25'
param endpointSubnetPrefix string = '10.80.0.128/28'

// Default off. Creating these resources has a monthly cost (see the Gate 008E cost estimate).
param deployNetwork bool = false

var appsSubnetName = 'snet-cbc-aca'
var endpointSubnetName = 'snet-cbc-pe'
var postgresPrivateDnsZone = 'privatelink.postgres.database.azure.com'
var tags = {
  project: 'checkbeforeclick'
  component: 'private-network'
}

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' existing = {
  name: postgresServerName
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsName
}

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = if (deployNetwork) {
  name: vnetName
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        vnetAddressPrefix
      ]
    }
    subnets: [
      {
        name: appsSubnetName
        properties: {
          addressPrefix: appsSubnetPrefix
          delegations: [
            {
              name: 'container-apps'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
        }
      }
      {
        name: endpointSubnetName
        properties: {
          addressPrefix: endpointSubnetPrefix
        }
      }
    ]
  }
}

resource postgresDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = if (deployNetwork) {
  name: postgresPrivateDnsZone
  location: 'global'
  tags: tags
}

resource postgresDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = if (deployNetwork) {
  parent: postgresDnsZone
  name: '${vnetName}-link'
  location: 'global'
  tags: tags
  properties: {
    registrationEnabled: false
    virtualNetwork: {
      id: vnet.id
    }
  }
}

resource postgresEndpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = if (deployNetwork) {
  name: privateEndpointName
  location: location
  tags: tags
  properties: {
    subnet: {
      id: resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, endpointSubnetName)
    }
    privateLinkServiceConnections: [
      {
        name: 'postgres'
        properties: {
          privateLinkServiceId: postgres.id
          groupIds: [
            'postgresqlServer'
          ]
        }
      }
    ]
  }
  dependsOn: [
    vnet
  ]
}

resource postgresEndpointDns 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = if (deployNetwork) {
  parent: postgresEndpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'postgres'
        properties: {
          privateDnsZoneId: postgresDnsZone.id
        }
      }
    ]
  }
}

// New environment: Consumption workload profile only (no Dedicated profile, so no management charge), external
// ingress so the website stays reachable; the environment's outbound traffic reaches PostgreSQL through the
// private endpoint because the linked private DNS zone resolves the server's normal FQDN to the private IP.
resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = if (deployNetwork) {
  name: environmentName
  location: location
  tags: tags
  properties: {
    vnetConfiguration: {
      infrastructureSubnetId: resourceId('Microsoft.Network/virtualNetworks/subnets', vnetName, appsSubnetName)
      internal: false
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
  dependsOn: [
    vnet
    postgresDnsLink
  ]
}

output networkEnabled bool = deployNetwork
output environmentDefaultDomain string = deployNetwork ? environment!.properties.defaultDomain : ''
