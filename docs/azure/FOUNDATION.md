# Azure Foundation Design - CheckBeforeClick

## 1. Purpose

This document defines the Azure foundation for CheckBeforeClick before implementation.

The goal is to move CheckBeforeClick toward an Azure-only architecture that is bold, serious, secure, marketable, and investor-readable without becoming bloated or wasteful.

This is not a cheap MVP design.

This is a lean but premium Azure-native foundation designed to support:

- customer trust
- tenant isolation
- Microsoft ecosystem credibility
- Canada Central data residency
- demo readiness
- investor confidence
- MSP/MSSP marketability
- future scale
- controlled operating cost

## 2. Current status

Completed before this design:

- RISK-05 closed
- Environment separation closed
- Production/staging separation verified
- Inngest Branch Environment separation complete
- Vercel env-var inventory complete
- Production test-data decision closed: retain/delete nothing
- Dependabot/PostCSS triaged as low practical risk
- Gate 1 service-role chokepoint refactor completed on Preview
- Current Preview commit: 970132b
- Tenant isolation behavior verified on Preview
- pg_policies listing captured

## 3. Target architecture

Target end-state:

- No Vercel
- No Supabase
- No Inngest
- Azure-only production runtime

Target Azure components:

| Capability | Azure service |
|---|---|
| App hosting | Azure Container Apps |
| Database | Azure Database for PostgreSQL Flexible Server |
| Region | Canada Central where practical |
| Authentication | Microsoft Entra External ID |
| Background jobs | Azure Service Bus + worker |
| Secrets | Azure Key Vault |
| File/evidence storage | Azure Blob Storage only where needed |
| Monitoring | Application Insights + Log Analytics |
| Budget control | Azure Budgets + alerts |

## 4. Services selected

### 4.1 Azure Container Apps

Selected for app hosting.

Reason:

- Azure-native
- good fit for containerized Next.js/backend workloads
- supports scale-to-zero / low-scale economics
- simpler than AKS
- more flexible than classic App Service for worker/container patterns
- investor-readable without enterprise bloat

### 4.2 Azure Database for PostgreSQL Flexible Server

Selected for the system of record.

Reason:

- current data model is PostgreSQL
- migration path from Supabase Postgres is natural
- Canada Central corrects current region mismatch
- supports relational tenant model
- avoids unnecessary Cosmos DB complexity

Initial posture:

- start with the smallest safe SKU for staging/rehearsal
- production SKU to be chosen after load expectations and cost review
- no high availability until justified
- no oversized storage
- backups enabled with sane retention

### 4.3 Microsoft Entra External ID

Selected for authentication.

Reason:

- Microsoft-aligned product story
- better enterprise credibility
- appropriate for future B2B SaaS posture
- supports the Azure-native positioning

Current Supabase Auth concepts must be replaced by application-controlled identity resolution.

### 4.4 Azure Service Bus + worker

Selected for background scan jobs.

Reason:

- replaces Inngest with Azure-native queueing
- supports durable async processing
- better than ad-hoc background work
- fits scan processing model

Initial worker must reload scan and organization context from the database. It must not trust tenant context from the message payload alone.

### 4.5 Azure Key Vault

Selected for secrets.

Reason:

- central place for application secrets
- better audit/security story
- avoids scattering secrets across runtime config

### 4.6 Azure Blob Storage

Selected only if needed.

Use cases:

- exported reports
- uploaded evidence files
- future customer-visible artifacts
- migration backups if appropriate

Do not use Blob Storage just to appear enterprise.

### 4.7 Application Insights + Log Analytics

Selected for basic monitoring.

Rules:

- controlled retention
- no expensive log firehose
- log only what helps debugging, security, or reliability
- no secrets or sensitive scan content in logs

## 5. Services explicitly avoided for now

These are not part of the first Azure-only release unless a specific blocker appears:

- AKS
- Cosmos DB
- Microsoft Sentinel
- Defender plans everywhere
- Azure Front Door Premium/WAF
- multi-region infrastructure
- oversized PostgreSQL
- always-on full duplicate staging
- expensive log retention
- complex private networking
- enterprise compliance pack

Reason:

The goal is a serious Azure-native product, not enterprise-cost theater.

## 6. Budget guardrails

Available strategic budget context:

- Azure credit: approximately $1,000
- personal reserve: approximately $2,000
- goal: build a serious Azure-only product without wasting runway

Budget rules:

- create Azure Budget alerts before paid resources
- monthly target: approximately $300 or less during build/rehearsal
- review threshold: $400/month
- stop-and-explain threshold: $500/month
- no premium service without explicit approval
- no always-on duplicated infrastructure without approval

Budget alerts:

- 50%
- 75%
- 90%
- 100%
- forecasted 100%

## 7. Target tenant schema

The target Azure PostgreSQL schema should support the current product and future MSP/client expansion.

Core tables:

- organizations
- users
- memberships
- identity_links
- scans
- vendor_results
- evidence_items
- scan_feedback
- audit_log
- alerts
- watchlist
- scan_cache

## 8. Organizations

Organizations are tenants.

Every customer account, MSP client account, or internal test account is represented as an organization.

Rules:

- every scan belongs to one organization
- organization ID is never trusted from the client
- organization context is resolved server-side
- future MSP model can manage multiple organizations through memberships

## 9. Users

Users represent internal application users, not raw external identity records.

Target users table should include:

- id
- email
- full_name
- status
- created_at
- updated_at

The current Supabase `auth.users.id = public.users.id` coupling should not be carried forward as the long-term model.

## 10. Memberships

Introduce memberships now.

Reason:

- forward-compatible
- supports future MSP/client separation
- supports multi-org access
- supports roles
- avoids another tenant-model migration later

Initial state:

- one membership per user
- one organization per user for now
- future support for multi-org access

Suggested fields:

- id
- user_id
- organization_id
- role
- status
- created_at
- updated_at

Initial roles:

- owner
- admin
- member
- viewer

MVP can use owner/admin/member only if simpler.

## 11. Identity links

Identity links connect Entra External ID identities to internal users.

Suggested fields:

- id
- provider
- provider_subject
- email_normalized
- user_id
- linked_at
- last_seen_at

Rules:

- provider_subject must be unique
- email must be normalized/lowercased
- Entra email must be verified
- relink happens only once
- ambiguous email matches are blocked
- duplicate email conflicts are blocked
- link events should be audit logged

## 12. Existing user relink model

Existing users will be relinked by verified normalized email on first Entra login.

Flow:

1. User signs in with Entra External ID.
2. App validates token/session.
3. App extracts verified email and external subject.
4. App checks identity_links.
5. If link exists, resolve internal user.
6. If no link exists, match exactly one existing user by normalized email.
7. If one match exists, create identity link.
8. If zero match exists, run new-user provisioning.
9. If multiple matches exist, block and require admin/manual resolution.

## 13. New signup provisioning

Supabase trigger-based provisioning must move into the app.

Current behavior:

- Supabase auth.users insert triggers handle_new_user()
- trigger creates organization
- trigger creates users row
- role defaults to admin
- organization name comes from metadata or fallback

Target behavior:

- app-layer transactional provisioning
- idempotent under callback retries
- creates organization
- creates user
- creates membership
- creates identity link
- logs provisioning event

Provisioning must be:

- transactional
- idempotent
- safe under retry
- safe under duplicate email
- safe under partial failure

## 14. Auth context

Create a single auth/tenant context resolver.

Target abstraction:

- getAuthContext()

It should return:

- authenticated external identity
- internal user id
- active organization id
- role
- membership id
- authorization metadata

Rules:

- every protected route uses getAuthContext()
- every API route uses getAuthContext()
- no protected operation trusts client-supplied organization_id
- no route hand-rolls identity or tenant lookup

## 15. Tenant isolation invariants

Non-negotiable:

1. No client-supplied organization_id is trusted.
2. Every user request resolves organization context server-side.
3. Every scan belongs to exactly one organization.
4. Every vendor result and evidence item belongs to the same organization as its scan.
5. Child records are queried by both organization_id and scan_id where possible.
6. Background workers reload scan and organization context from the database.
7. Service/privileged access goes through the approved data-access chokepoint.
8. Cross-org access returns not found and does not leak existence.
9. Tenant isolation must be tested by behavior before production cutover.
10. Zero cross-tenant leakage in staging rehearsal, or no production cutover.

## 16. RLS direction

Current Supabase RLS depends mainly on get_user_org_id(), which depends on auth.uid().

Azure target options:

Option A:
Application-layer tenant authorization only.

Option B:
Application-layer tenant authorization plus PostgreSQL RLS defense-in-depth using session variables.

Preferred direction:

Use application-layer tenant authorization as the primary enforcement model, with PostgreSQL RLS considered as defense-in-depth for tables where it adds clear value.

Final RLS/session-var design requires the captured pg_policies listing and a separate design gate.

## 17. Background job model

Current:

- Inngest handles scan processing
- branch environments isolate Preview jobs
- worker now uses the data-access chokepoint

Target:

- Azure Service Bus message
- worker consumes message
- message carries scan_id
- worker reloads scan and organization_id from database
- worker writes through data-access module
- message payload does not become source of tenant truth

Rules:

- no tenant context is trusted from message alone
- failed jobs update scan status safely
- retries must not duplicate evidence/vendor rows unexpectedly
- worker errors must be observable

## 18. Secrets model

Secrets move to Azure Key Vault or managed app secrets depending on implementation stage.

Secrets include:

- database connection strings
- Entra configuration
- Google Web Risk key
- Anthropic key
- queue connection secrets if required

Rules:

- no secrets in Git
- no secrets in chat
- no secrets in logs
- least privilege wherever practical
- rotate if exposed

## 19. Monitoring model

Minimum monitoring:

- app availability
- failed auth callbacks
- failed provisioning
- failed scans
- failed background jobs
- tenant-isolation test failures
- queue depth / dead-letter count
- database connection errors

Avoid:

- excessive log ingestion
- storing sensitive scan contents in logs
- expensive retention before customers justify it

## 20. Cutover assumptions

Production cutover may be offline.

Assumptions:

- downtime acceptable
- static placeholder acceptable
- no real paying customers yet
- Supabase retained temporarily as rollback/soak
- production writes frozen during cutover

Cutover steps later:

1. announce/activate placeholder
2. freeze writes
3. export Supabase production data
4. transform data
5. import to Azure PostgreSQL
6. configure Azure app
7. test auth/login
8. test scan
9. test tenant isolation
10. point domain
11. monitor
12. keep rollback path

## 21. Rollback and soak

Supabase should not be deleted immediately after cutover.

Recommended soak:

- minimum 7 days
- preferred 14 days if practical

During soak:

- Supabase frozen/read-only for production use
- backups retained
- rollback path documented
- no new production writes to Supabase unless rollback is executed

## 22. What is not being built before end-of-June cutover

Do not build yet:

- Outlook plugin
- Teams plugin
- Slack plugin
- full MSP multi-client portal
- complex billing
- enterprise compliance pack
- AKS
- Cosmos DB
- Sentinel
- full WAF/Front Door Premium
- multi-region
- advanced admin console
- full white-label system

These may be future differentiators, but not first Azure cutover requirements.

## 23. End-of-June production-ready scope

Must work:

- login
- signup/provisioning
- existing user relink
- organization/user/membership resolution
- scan submit
- background processing
- result page
- evidence/vendor display
- scan status
- dashboard basics
- tenant isolation
- secrets
- monitoring basics
- rollback path

Should work if already reliable:

- scan history
- feedback/correction

May be deferred:

- advanced MSP/client separation
- billing
- integrations
- advanced reporting

## 24. Main risks

| Risk | Severity | Mitigation |
|---|---:|---|
| Cross-tenant data leakage | Blocker | tenant-isolation test suite and staging rehearsal |
| Broken signup provisioning | High | transactional/idempotent app-layer provisioning |
| Existing user relink mistake | High | verified email, unique match, audit log |
| Service access bypass | High | data-access chokepoint |
| Worker tenant-context failure | High | reload org from DB by scan_id |
| Domain/callback misconfig | Medium | staged callback testing |
| Azure cost creep | Medium | budget alerts and service restrictions |
| Data migration error | High | staging rehearsal, counts, relation checks |
| Rollback confusion | High | rollback plan before cutover |

## 25. Gates before implementation

Next gates:

1. Gate 1B - production promotion decision for service-role chokepoint
2. Gate 2A - Azure resource naming and budget alert setup
3. Gate 2B - Azure PostgreSQL schema design
4. Gate 2C - Entra External ID app/auth design
5. Gate 2D - Service Bus worker design
6. Gate 3 - implementation sequence

## 26. Final recommendation

Build boldly, but with disciplined gates.

CheckBeforeClick should become a lean, premium, Azure-native cybersecurity SaaS.

The architecture must be serious enough for buyers and investors, but controlled enough to ship by end of June.

The winning path is:

- centralized tenant-safe data access
- Azure PostgreSQL in Canada Central
- Entra External ID
- memberships and identity_links
- Azure-native queue/worker
- controlled cost
- professional product experience
- zero cross-tenant leakage
- demo/investor readiness in parallel

Last updated: 2026-06-10

## 27. Azure foundation setup evidence

Completed Azure foundation setup:

- Azure CLI installed and authenticated
- Default subscription selected: Azure subscription 1
- Region confirmed: Canada Central (`canadacentral`)
- Monthly budget guardrail created
- Production resource group created

Budget guardrail:

| Setting | Value |
|---|---|
| Budget name | `cbc-monthly-cost-guardrail` |
| Amount | `$300/month` |
| Time grain | Monthly |
| Notifications | 50%, 75%, 90%, 100%, forecasted 100% |
| Contact emails | `mr.waberi@gmail.com`, `wberytech@gmail.com` |

Production resource group:

| Setting | Value |
|---|---|
| Name | `rg-cbc-prod-canadacentral-001` |
| Region | `canadacentral` |
| Product tag | `checkbeforeclick` |
| App tag | `cbc` |
| Environment tag | `prod` |
| Owner tag | `wabcan` |
| Purpose tag | `azure-foundation` |
| Cost guardrail tag | `cbc-monthly-cost-guardrail` |

No application runtime, database, queue, Key Vault, storage account, or production traffic has been moved yet.

Status: Gate 2A complete.

## 28. Key Vault foundation evidence

Completed Key Vault foundation setup:

- Microsoft.KeyVault provider registered
- Production Key Vault created
- RBAC authorization enabled
- Purge protection enabled
- Soft delete retention set to 30 days
- Founder/operator secret-management access verified
- Secret listing command succeeds
- No production secrets have been added yet

Key Vault:

| Setting | Value |
|---|---|
| Name | `kv-cbc-prod-cc-001` |
| Resource group | `rg-cbc-prod-canadacentral-001` |
| Region | `canadacentral` |
| RBAC authorization | Enabled |
| Purge protection | Enabled |
| Soft delete retention | 30 days |
| Purpose tag | `secrets-foundation` |

Current secret state:

| Secret category | Status |
|---|---|
| Database secrets | Not created yet |
| Entra secrets | Not created yet |
| Google Web Risk key | Not migrated yet |
| Anthropic key | Not migrated yet |
| Queue secrets | Not created yet |
| App runtime secrets | Not created yet |

No application runtime, database, queue, storage account, or production traffic has been moved yet.

Status: Gate 2B complete.

## 29. PostgreSQL creation attempt and correction

A first PostgreSQL Flexible Server creation attempt was made during Gate 2C discovery.

The requested design was:

- Server: `pg-cbc-prod-cc-001`
- SKU: `Standard_B2s`
- Tier: Burstable
- PostgreSQL version: 16
- Storage: 32 GB
- Tags: required foundation tags

Azure CLI created a different server shape than intended:

- SKU: `Standard_D2ds_v5`
- Tier: GeneralPurpose
- PostgreSQL version: 18
- Storage: 128 GB
- Tags: null

Decision:

- The created server was not accepted.
- The server was deleted immediately.
- No app traffic was moved.
- No customer data was stored.
- No schema migration was run.

Secret handling:

- A temporary database admin password was generated locally.
- The temporary Key Vault secret `postgres-admin-password` was deleted.
- Because purge protection is enabled, the deleted secret cannot be manually purged.
- Azure will automatically purge it after the retention period.
- Active Key Vault secret list is empty.
- Future PostgreSQL creation must use a new secret name.

New rule:

Do not use the simplified `az postgres flexible-server create` flow for production foundation unless exact resulting SKU, version, storage, networking, and tags can be guaranteed.

Next PostgreSQL attempt must use a controlled template, explicit deployment method, or carefully reviewed Azure Portal creation path.

Status: Failed creation attempt safely corrected.

## 30. PostgreSQL foundation deployment evidence

A controlled ARM deployment was used to create the production PostgreSQL foundation after the earlier simplified CLI attempt was rejected.

Deployment source:

- Template: `infra/azure/postgres-flexible-server.prod.json`
- Parameters: `infra/azure/postgres-flexible-server.prod.parameters.json`
- Deployment method: Azure Resource Manager group deployment
- What-if reviewed before creation
- Template committed before deployment

PostgreSQL Flexible Server:

| Setting | Value |
|---|---|
| Server name | `pg-cbc-prod-cc-001` |
| FQDN | `pg-cbc-prod-cc-001.postgres.database.azure.com` |
| Resource group | `rg-cbc-prod-canadacentral-001` |
| Region | `canadacentral` |
| PostgreSQL version | `16` |
| SKU | `Standard_B2s` |
| Tier | `Burstable` |
| Storage | `32 GB` |
| Public network access | Enabled |
| High availability | Disabled |
| Backup retention | 7 days |
| Managed by | `arm-template` |

Database:

| Setting | Value |
|---|---|
| Database name | `cbc_prod` |
| Charset | `UTF8` |
| Collation | `en_US.utf8` |

Firewall:

| Rule | Start IP | End IP |
|---|---|---|
| `admin-current-ip` | `129.224.217.0` | `129.224.217.255` |

Secret storage:

| Secret | Status |
|---|---|
| `postgres-prod-admin-password` | Created in Key Vault |
| Secret value exposed in verification output | No |
| Local password variable | Removed after storage |

Tags verified:

- `product=checkbeforeclick`
- `app=cbc`
- `environment=prod`
- `region=canadacentral`
- `owner=wabcan`
- `purpose=postgres-foundation`
- `costGuardrail=cbc-monthly-cost-guardrail`
- `managedBy=arm-template`

No schema migration has been run yet.
No Supabase production data has been imported yet.
No application traffic has been moved yet.

Status: Gate 2C PostgreSQL foundation complete.

## 31. PostgreSQL connection test evidence

A direct PostgreSQL client connection test was completed against the Azure PostgreSQL Flexible Server foundation.

Client:

| Setting | Value |
|---|---|
| Client | `psql` |
| Client version | `16.14` |
| Connection method | Full local `psql.exe` path |
| Password handling | Loaded from Key Vault into memory only |
| Password printed in terminal | No |

Connection target:

| Setting | Value |
|---|---|
| Host | `pg-cbc-prod-cc-001.postgres.database.azure.com` |
| Database | `cbc_prod` |
| User | `cbcpgadmin` |
| SSL mode | `require` |

Connection evidence:

| Check | Result |
|---|---|
| SSL connection | Success |
| TLS version | `TLSv1.3` |
| Cipher | `TLS_AES_256_GCM_SHA384` |
| Database prompt reached | Yes |
| User tables found | No relations found |
| Current database | `cbc_prod` |
| Current user | `cbcpgadmin` |
| PostgreSQL server version | `PostgreSQL 16.14` |

Result:

The Azure PostgreSQL production foundation is reachable, SSL-protected, and empty as expected before schema migration.

No schema migration has been run yet.
No Supabase production data has been imported yet.
No application traffic has been moved yet.

Status: Gate 2D PostgreSQL connection test complete.

## 32. Gate 2H production baseline schema apply

Gate 2H applied the approved Azure-safe baseline schema migration to `cbc_prod`.

Migration file:

- `infra/db/migrations/001_initial_schema.sql`

Result:

- Production database target confirmed as `cbc_prod`
- Database was empty before apply
- Baseline migration applied successfully
- 10 expected baseline tables created
- 18 public foreign keys verified
- No `auth.users` foreign key
- No Supabase schemas detected
- No RLS enabled
- Policy count is 0
- No app traffic moved
- No data imported

Important scope note:

`001_initial_schema.sql` is baseline-only. It is not the final tenant-isolation model.

The following remain deferred to Gate 002:

- `memberships`
- RLS
- session-variable authorization
- app-layer tenant authorization
- tenant-isolation enforcement tests

Status: Gate 2H production baseline schema apply complete.

## Gate 002 disposable dry-run

Gate 002 tenant isolation was validated against disposable database `cbc_002_validation`.

Results:

- 001 baseline applied successfully
- 002 tenant-isolation migration applied successfully
- RLS tested as `cbc_app_validation`, a non-owner NOBYPASSRLS runtime-like role
- Missing tenant context denied access
- Wrong tenant context denied access
- Valid membership allowed only own-tenant access
- Cross-tenant read/write attempts were denied
- Membership SELECT worked without recursion
- Membership mutation was restricted to owner/admin logic
- Audit log runtime behavior was append-only
- Bootstrap mismatch was denied
- Bootstrap session-user path succeeded
- `scan_cache` remained global/internal and outside tenant RLS
- Disposable DB and validation role were cleaned up

Status: Gate 002 disposable dry-run PASS.

No production database change was made.
