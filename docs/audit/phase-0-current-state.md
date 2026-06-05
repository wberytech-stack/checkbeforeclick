# CheckBeforeClick Phase 0 Current-State Audit

## Status

- Audit phase: Phase 0A — current-state capture and schema-baseline preparation
- Audit branch: `audit/azure-current-state`
- Production baseline commit: `50edc44`
- This phase performs no production changes.
- No database export has been executed during Phase 0A.

## Strategic Context

CheckBeforeClick is being intentionally transitioned from its current Supabase, Inngest, and Vercel architecture toward an Azure-native cybersecurity SaaS platform.

Microsoft for Startups has granted Wabcan Inc. an initial US$1,000 in Azure credits. The application for additional startup benefits has been submitted and is under review.

PostgreSQL remains the authoritative system of record throughout the migration.

## Current Production Stack

- Next.js 16
- Vercel hosting and preview deployments
- Supabase PostgreSQL
- Supabase Auth
- Supabase Row-Level Security
- Inngest background processing
- Google Web Risk provider integration
- GitHub source control

## Current Database State

The production Supabase project is currently hosted in Northeast Asia / Tokyo.

The production schema was built and evolved through Supabase dashboard and SQL activity. It is not currently represented by reproducible, version-controlled migration files.

Known public database objects:

- 10 public tables
- 24 RLS policies
- 44 constraints
- 32 indexes
- 3 public functions

Confirmed authentication trigger:

- Schema: `auth`
- Table: `users`
- Trigger: `on_auth_user_created`
- Timing: `AFTER INSERT`
- Action: `EXECUTE FUNCTION handle_new_user()`

Known row counts:

| Table | Rows |
|---|---:|
| organizations | 3 |
| users | 3 |
| scans | 75 |
| evidence_items | 94 |
| vendor_results | 86 |
| alerts | 0 |
| audit_log | 0 |
| scan_cache | 0 |
| scan_feedback | 0 |
| watchlist | 0 |

Database integrity checks returned zero:

- Missing auth or public user profiles
- Users without valid organizations
- Scan/user organization mismatches
- Evidence/scan organization mismatches
- Vendor-result/scan organization mismatches
- Feedback/scan organization mismatches
- Duplicate vendor results

Seven URL scans remain in `pending` status from May 28, 2026. They have not been modified during the audit.

## Confirmed Current Capabilities

- Multi-tenant organizations and users
- Supabase authentication
- Scan submission API
- URL and domain normalization
- SSRF-oriented target validation
- Google Web Risk integration
- Provider-result normalization
- Fail-closed URL verdict behavior
- Saved scans and results
- Inngest background worker
- Dashboard and scan-result pages
- Vercel production deployment
- Public production domain: `checkbeforeclick.com`

## Known Security, Reliability, and Architecture Risks

- Production database schema is not version-controlled.
- Service-role database operations bypass RLS and depend on correct application filtering.
- Worker processing is not idempotent.
- No complete automated regression and tenant-isolation test suite exists.
- Seven scans remain stale in `pending` status.
- Production and Preview deployments currently share backend credentials.
- Users may be able to update sensitive profile fields such as role or organization.
- Authenticated users may be able to write authoritative evidence, vendor results, or audit entries.
- Shared scan cache may be vulnerable to cache poisoning if writes are not backend-controlled.
- Current user model supports only one organization per user.
- URL scans currently run synchronously inside the API request.
- Queue publishing is not transactional.
- Current Supabase production region may create future latency and data-residency concerns.
- Vercel production deploys directly from `master`.
- Current observability and long-term operational monitoring are limited.

These risks are documented findings. They have not yet been remediated unless explicitly stated elsewhere.

## Approved Azure Target Architecture

- Azure Front Door Premium and WAF
- Azure Container Apps
- Microsoft Entra External ID
- Azure Database for PostgreSQL
- Azure Service Bus
- Azure Blob Storage
- Azure Key Vault
- Application Insights and Log Analytics

Azure PostgreSQL will remain the authoritative transactional and tenant-data system of record.

Cosmos DB is not part of the initial approved production architecture. It may later be considered only for specialized derived-data workloads.

## Phase 0A Objective

Prepare a safe, reproducible workflow for capturing the authoritative production database schema before creating staging or beginning Azure migration work.

The schema baseline must capture, at minimum:

- Tables
- Constraints
- Indexes
- Functions
- Triggers
- RLS policies
- RLS enablement
- Roles and grants
- Required extensions and types

No production table data will be exported into the repository.

## Phase 0A Exit Criteria

Phase 0A is complete only when:

- The schema-export script passes authoritative PowerShell syntax validation.
- The script verifies the exact linked Supabase project.
- The script validates required Supabase CLI dump flags before export.
- Generated exports use timestamped, collision-safe filenames.
- Generated private exports remain excluded from Git.
- The structural summary lists relevant schema objects and RLS statements.
- The export process is documented and reproducible.
- No secrets, connection strings, or production data are committed.
- Required evidence is reviewed and accepted.
- No production system or data is changed during validation.
