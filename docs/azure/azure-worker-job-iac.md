# Azure scheduled URL worker — authored only, not deployed

This template is a **separate** Azure Container Apps Job for the clean-start
CheckBeforeClick scan outbox. It does not reuse the web application's identity,
Supabase, Inngest or a schema-owner database login. The existing standalone
`Dockerfile.azure-worker` and `runAzureUrlWorkerOnce` entrypoint are the image
contract. The job polls PostgreSQL's durable outbox; **Service Bus is not
required for this initial vertical slice**. The outbox itself provides durable
delivery, leases and idempotent completion. Consider a queue only after
measuring the polling/latency tradeoff.

## Files

- `infra/azure/hosting/azure-url-worker-job.bicep`: independent resource-group
  template; references the existing Container Apps environment, registry,
  Key Vault and web identity. Creates only a dedicated worker identity, narrowly
  scoped ACR pull and **single-secret** Key Vault RBAC, and a scheduled Job.
- `scripts/azure-data/test-worker-job-iac.mjs`: offline safety assertions and
  mutation checks, run in the read-only pull-request CI.
- `Dockerfile.azure-worker`: non-root one-shot worker, no HTTP listener.

## Safe-by-default contract

Both `deployWorker` **and** `allowPaidProvider` default to `false`. No
worker resources are declared active unless **both** are explicitly true.
Even a dry-run/what-if is founder-only under AGENTS.md. These flags are not
billing authorization. Enabling a scheduled job can incur Azure compute,
registry, monitoring and Key Vault charges. Google Web Risk requests may also
incur charges. **No cloud provisioning or paid calls are authorized by this
PR.** A 5-minute schedule would start up to 288 job executions per day, even
with an empty outbox. The founder must review actual provider pricing, quotas
and budget before choosing a schedule.

The job is not public and has no ingress. It runs a single replica with one
completion, 180-second platform timeout and zero platform-level retries.
Database leases are the retry mechanism. The image uses a SHA-256 digest
rather than a mutable tag. The worker gets its own managed identity and
passwordless Entra token, verified PostgreSQL TLS, and the `cbc_worker`
role. The existing runtime rejects admin/BYPASSRLS roles and identity reuse.
Only the provider's Key Vault **secret resource** is granted to the worker.
The web identity client ID is passed only for the runtime separation check.

The database URL is intentionally passwordless. Do **not** store credentials
in it or use the PostgreSQL administrator. Identity-to-PostgreSQL-principal
binding is **not** created by this template; an authorized operator must
verify that the Entra identity can authenticate as exactly `cbc_worker`
with no broader privileges. Do not assume a similarly named identity is
automatically mapped to that PostgreSQL role.

## Before a founder-approved what-if or deployment

1. Review AGENTS.md, migrations 005–009, the `cbc_worker` grants and the
   existing Azure resources. Verify the worker identity name differs from
   the web identity name; check the database Entra principal mapping.
2. Build and review the worker image from `Dockerfile.azure-worker`, publish
   only with explicit approval, and supply its immutable 64-character SHA-256
   digest. Confirm the registry repository is `cbc-azure-worker`.
3. Verify the Key Vault secret name exists and access is limited to that
   one secret. Do not expose its value. Confirm the Web Risk service's
   permitted use, quota and billing separately.
4. Supply environment, registry, Key Vault, web identity, worker identity,
   job, database host/name and secret name as parameters. Review the
   schedule and its expected costs. Run `az bicep build` **locally** and
   founder-run `az deployment group what-if` before any apply.
5. Approve any resource provisioning, PostgreSQL principal/grants,
   secrets and image deployment as **separate scoped actions**. Verify a
   real Entra token and verified TLS before processing any job.
6. Smoke-test authenticated submission, one-shot lease claim, provider
   outage, completion, retry after crash, terminal result retrieval and
   tenant isolation. Observe real job failures, budget, and queue age.

## Recovery and limitations

A failed job exits nonzero; `replicaRetryLimit: 0` prevents the platform
from immediately replaying a paid call. The PostgreSQL outbox retries when
the lease expires, up to its attempt cap; exhausted work requires explicit
operator review. An external provider call may happen more than once after
a crash; only database completion is idempotent. This is **not** an
exactly-once-billing guarantee.

For rollback, an authorized operator disables the scheduled Job and stops
new scan submissions, preserves PostgreSQL outbox/evidence, then reviews
pending and leased work before any retry. Never delete queued work or
re-enable the old Inngest path automatically.

Offline checks validate only the authored safety contract, not Bicep
compilation, Azure deployment, identity permissions, or live provider calls.
The existing hosting template still contains legacy web secrets; do not use
it as proof of a clean Azure-only web deployment. The Azure-only web
deployment IaC remains a separate integration task.
