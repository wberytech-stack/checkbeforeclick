# Gate 008E: private application-to-database network (offline design)

**Status:** offline design, infrastructure code and tests only (lead review 6900589055 on PR #59).
- **Nothing is provisioned.** `deployNetwork` defaults to `false`.
- Every Azure change below needs the founder's explicit approval of a reviewed what-if.
- Prices are **estimates** unless marked verified.

## 1. Why

S0 found that the existing server `pg-cbc-prod-cc-001`:
- uses public-access mode, with `activeDirectoryAuth: Disabled`;
- has exactly one firewall rule, `admin-current-ip` (`129.224.217.0/24`), and **no** "allow Azure services" rule.

So no Container Apps environment can reach it today. **Opening the server to all Azure services (`0.0.0.0`) is rejected:** it would admit any Azure customer's workloads to the database's sign-in surface. The design gives the new web app and worker a **private path**, while leaving everything that exists today untouched.

## 2. Current vs target

```text
CURRENT (unchanged by this gate)
  Internet ──► cae-cbc-prod-cc-001 (existing env) ──► ca-cbc-web-stg-cc-001 (legacy, uses Supabase)
  Founder IP range 129.224.217.0/24 ──firewall──► pg-cbc-prod-cc-001 (public endpoint) ── cbc_prod

TARGET (only when deployNetwork=true, founder-approved)
  Internet ──HTTPS──► cae-cbc-azweb-cc-001 (NEW env, external ingress, Consumption profile)
                        │  subnet snet-cbc-aca 10.80.0.0/25 (delegated Microsoft.App/environments)
                        ├─ ca-cbc-azweb-cc-001  (web, later stage)
                        └─ caj-cbc-urlworker-cc-001 (worker, later stage)
                              │ DNS: pg-cbc-prod-cc-001.postgres.database.azure.com
                              │   → CNAME …privatelink.postgres.database.azure.com
                              │   → A 10.80.0.13x (private DNS zone linked to the VNet)
                              ▼
                        snet-cbc-pe 10.80.0.128/28 ── pe-cbc-pg-cc-001 ──Private Link──► pg-cbc-prod-cc-001
                                                                                            └ cbc_cleanstart (later, S4)
  vnet-cbc-azweb-cc-001 10.80.0.0/24, private DNS zone privatelink.postgres.database.azure.com
  The public endpoint, the firewall rule and cbc_prod stay exactly as they are.
```

**What stays untouched:**
- `pg-cbc-prod-cc-001`: its settings, firewall, administrators and public access;
- the `cbc_prod` database;
- `cae-cbc-prod-cc-001`;
- `ca-cbc-web-stg-cc-001`;
- Key Vault and the registry.

The template only **references** the server and the Log Analytics workspace (`existing`).

## 3. Verified constraints (Microsoft Learn, via search results 2026-11-15)

1. **PostgreSQL networking mode is fixed at server creation.** Moving a server into a virtual network (VNet integration) after creation is not supported.
2. **Private endpoints are available only for public-access servers** created after the Private Link feature was released. VNet-integrated servers can't take one.
   - Our server is public-access (S0 E6) and was deployed 2026-06-12 (S0 E10), so it **should be eligible**. Founder check N1 must prove it before approval.
   - A private endpoint **does not** turn the server into a VNet-integrated server: its public endpoint and firewall stay as they are.
3. **Container Apps:**
   - private endpoints and user-defined routes need a **workload-profiles** environment;
   - the subnet must be delegated to `Microsoft.App/environments`, minimum **/27** (the current table lists 14 reserved addresses);
   - **the subnet size cannot be changed after the environment is created**;
   - an existing environment cannot be moved into a VNet, so a **new** environment is required, and it has a **new default domain**.
4. **DNS.** Inside the VNet, Azure-provided DNS answers from private DNS zones linked to the VNet. The server's normal name resolves to the private endpoint IP, so `CBC_DATABASE_URL` keeps the same host, and verified TLS (chain and hostname) still matches the server certificate. Outside the VNet (the founder's laptop, the legacy app) nothing changes.

## 4. Design choices

| Choice | Value | Why |
| --- | --- | --- |
| Address space | `10.80.0.0/24` (RFC 1918) | small, no peering planned; founder check N3 confirms there's no overlap |
| Container Apps subnet | `10.80.0.0/25` | it can't be resized later; /25 leaves headroom (~114 usable) at no extra cost |
| Endpoint subnet | `10.80.0.128/28` | one private endpoint; room for a future Key Vault endpoint |
| Workload profile | **Consumption only** | a Dedicated profile adds a management charge; the guard refuses it |
| Ingress | external | the website must be public; the database path is private |
| Zone redundancy | off | separate cost decision |
| NAT gateway, public IP, peering, DDoS plan, firewall rule | **none** | refused by the guard and the compiled check |
| Identities and roles | **none created** | the network grants nothing; the web and worker templates keep their per-secret roles |

**Routing:**
- environment subnet → endpoint subnet over VNet system routes; no route table;
- outbound to Entra, Key Vault and Google Web Risk uses the platform's default outbound path.

## 5. Founder read-only prerequisites (N1–N7; none changes anything)

```bash
RG=rg-cbc-prod-canadacentral-001; PG=pg-cbc-prod-cc-001; PGID=$(az postgres flexible-server show -g $RG -n $PG --query id -o tsv)
```

| # | Command | Must show |
| --- | --- | --- |
| N1 | `az network private-link-resource list --id $PGID --query "[].groupId" -o tsv` | `postgresqlServer` (private endpoint eligible) |
| N2 | `az postgres flexible-server show -g $RG -n $PG --query "{subnet:network.delegatedSubnetResourceId, dnsZone:network.privateDnsZoneArmResourceId, public:network.publicNetworkAccess}"` | subnet and zone `null`, public `Enabled` (public-access mode) |
| N3 | `az network vnet list --query "[].{name:name, rg:resourceGroup, prefixes:addressSpace.addressPrefixes}" -o table` | nothing overlapping `10.80.0.0/24` |
| N4 | `az network private-dns zone list --query "[].{name:name, rg:resourceGroup}" -o table` | no existing `privatelink.postgres.database.azure.com` (otherwise reuse it, never duplicate it) |
| N5 | `az network private-endpoint-connection list --id $PGID -o table` | no existing connections |
| N6 | `az provider show -n Microsoft.Network --query registrationState -o tsv` and the same for `Microsoft.App` | `Registered` |
| N7 | Azure Pricing Calculator (Canada Central): private endpoint, private DNS zone, workload-profiles environment with a custom VNet; afterwards, Cost Management for the environment's managed resource group | the monthly total in your billing currency |

## 6. Incremental monthly cost (estimates; verify with N7)

| Item | Estimate | Basis | Confidence |
| --- | --- | --- | --- |
| Private endpoint (1) | ~US$7.30 (~$0.01/h) + ~$0.01/GB processed in and out | Microsoft Q&A answers; the official page didn't render rates | estimate |
| Private DNS zone (1) + VNet link | ~US$0.50 per zone + ~$0.40 per million queries | Azure DNS pricing structure confirmed; amounts from memory | **unverified** |
| Virtual network, subnets | US$0 | VNets are free | estimate |
| New environment, Consumption profile | US$0 base; usage is billed per second **after** the subscription's monthly free grant (180,000 vCPU-s, 360,000 GiB-s, 2M requests, **shared** with every app in the subscription) | free grant from Microsoft docs; per-second rates third-party (US East: ~$0.000024/vCPU-s active, ~$0.000003/GiB-s) | grant verified, rates estimate |
| **Possible environment infrastructure in its managed resource group: standard static public IP(s) and a standard load balancer** | **~US$0–26** (≈ $3.65 per public IP, ≈ $18 for a load balancer) | the Microsoft networking page says a custom-VNet environment is billed for these; whether and how it applies to a workload-profiles environment could not be confirmed from this session | **unverified, must be settled by N7** |
| Log Analytics (new environment's logs into the existing workspace) | US$0 within 5 GB/month free per billing account, then ~US$2.30/GB | third-party guides | estimate |
| Outbound data transfer | likely within the monthly free allowance at current volume | memory | **unverified** |

**Range:** about **US$8–11/month** if the managed public IPs and load balancer are not billed, up to **about US$30–37/month** if they are. Compute beyond the free grant comes on top, and the grant is shared with existing usage.

**For comparison:**
- a NAT gateway with a static IP (option 2) adds roughly US$32+/month;
- "allow all Azure services" (option 1) is free, but rejected on security grounds.

## 7. Deployment sequence (each step separately approved)

1. **S0b:** run N1–N7. If anything differs from the expected result, stop.
2. **S2a: network what-if** with `deployNetwork=true`, checked by
   `node scripts/azure-data/check-cleanstart-whatif.mjs --profile <local profile> --component network --enabled true --whatif <file>`.
   The guard accepts only the 6 expected `Create`s:
   - the VNet with exactly the two subnets;
   - the private DNS zone;
   - the VNet link (auto-registration off);
   - the private endpoint to **this** server with `postgresqlServer`;
   - the DNS zone group;
   - the Consumption-only external environment.

   It refuses any `Modify` or `Delete`, any change to the server or the existing environment, firewall rules, public IPs, NAT, peering and DDoS.
3. **S2a apply.** Read the new environment's default domain. That sets `publicOrigin`, which the Entra redirect URI then uses.
4. Then the web stages (S2/S3). The guard now also requires the web app and worker to run in **`cae-cbc-azweb-cc-001`**, never the existing environment.

**Who applies:** the legacy deployer identity has `Reader` + `CBC Staging Deployer` on the resource group, which likely lacks network permissions. The founder applies interactively, or approves a separate, scoped role. That is a decision, not an assumption.

## 8. Rollback

**Before any app uses the network,** delete in this order:
1. the environment;
2. the DNS zone group;
3. the private endpoint (the server's private endpoint connection is removed with it);
4. the VNet link;
5. the DNS zone;
6. the VNet.

The server, its public endpoint, its firewall rule and `cbc_prod` are unaffected throughout. Creating or removing a private endpoint is **not expected** to restart the server; confirm this in the approved runbook before S2a.

**After cutover,** removing the endpoint cuts the new app off from the database. Roll back the app first.

## 9. Duplicate prevention

- Names are deterministic in `infra/azure/cleanstart/cutover-profile.json` (`network.*`), and the profile validator refuses names equal to protected resources and the existing environment.
- `check-deployment-name-collisions.mjs` now accepts virtual networks, private endpoints and private DNS zones. Run it with E2 + N3 + N4 as the inventory.
- The what-if guard refuses duplicate resource IDs and any extra or missing `Create`.

## 10. Tests (offline, in PR CI)

- **`test-cleanstart-whatif.mjs`** (129 → **131** checks), Gate 008E part:
  - profile fields equal the Bicep parameters, and Bicep defaults equal the profile prefixes;
  - template literals match the guard;
  - the committed compiled template passes; 9 compiled-template mutations are refused, including a `0.0.0.0/0` default, an attached NAT gateway, an AllowAllAzure firewall rule and a Dedicated profile;
  - the exact network what-if is accepted;
  - 27 network negatives (NN01–NN27) and 8 profile negatives (NP01–NP08).
- **Mutation check of the guard:** 11/11 killed.
- **CI `compiled-iac`:** compiles and lints `azure-private-network.bicep` with the pinned CLI, and runs `--compiled-drift --network`.
- **Not exercised:** any Azure API, a real what-if, real DNS resolution, actual prices.
