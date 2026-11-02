# Azure URL reputation worker (draft, no deployment)

This is a **fresh Azure-native scan path**, not a legacy Inngest migration.
The separate Dockerfile.azure-worker builds a one-shot, non-root Azure
Container Apps Job. It imports no Supabase, Inngest or Next.js runtime code.

## Flow

1. The Entra-authenticated web API creates a pending tenant-bound scan.
2. PostgreSQL migration 008 atomically inserts a scan outbox row.
3. A scheduled Container Apps Job starts the dedicated worker image.
4. Its **separate managed identity** obtains an Entra PostgreSQL token for
   cbc_worker; TLS and role/privilege attestation fail closed.
5. It claims one bounded lease and checks the submitted URL against a
   **fixed Google Web Risk endpoint only**. It never opens the submitted
   URL, follows target redirects, resolves target DNS, or renders pages.
   This eliminates target-URL SSRF and DNS rebinding from this scan mode.
6. Migration 009 atomically saves evidence and terminal status only if
   the lease token is still valid. Timeouts and provider errors are
   **not acknowledged** and can be retried, up to the database attempt cap.

## Product semantics

A reported threat-list match is **dangerous**. No match is **unknown**,
**not safe**: a blocklist miss cannot prove a link is harmless. Unsupported
input types and ineligible URL formats fail without contacting the provider.
This is reputation-only; content inspection and additional vendors are future
independent adapters. The vendor result and evidence contain only sanitized
threat categories, never the API key or full provider response.

## Required settings (future deployment approval)

- CBC_WORKER_DATABASE_URL: postgres://cbc_worker@<verified-azure-pg-host>/<db>
- CBC_WORKER_AZURE_CLIENT_ID: worker-only managed identity GUID
- IDENTITY_ENDPOINT, IDENTITY_HEADER: injected by Azure Container Apps
- CBC_WEB_RISK_API_KEY: Web Risk key delivered at runtime from an approved
  secret store; **never** a Docker build argument or committed value
- AZURE_CLIENT_ID: optional web identity GUID for cross-role separation check

Google Web Risk is a **non-Azure paid service**; this code does not enable
billing, provision it, or make live requests during CI. Founder approval
is required before enabling a billable provider or creating secrets.
Its adapter can be replaced without changing the worker or database.

## Local/offline verification

    npm ci --ignore-scripts
    ./node_modules/.bin/tsc --noEmit -p tsconfig.json
    ./node_modules/.bin/tsc -p tsconfig.azure-worker.json
    node --experimental-strip-types scripts/azure-data/test-azure-url-processor.ts
    node --experimental-strip-types scripts/azure-data/test-azure-web-risk.ts

No Azure account or provider calls are needed for these tests. A production
release additionally requires approved resource provisioning, actual managed
identity/database grants, a scheduled job, a provider key, monitored job
failure/retry behavior, and an authenticated end-to-end scan smoke test.
