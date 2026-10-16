# Gate 006A - Azure Hosting Migration Plan and Governance (Phase 1)

## Status

Docs-only gate. It records the Phase 1 plan to move CheckBeforeClick's
**hosting** from Vercel to Azure Container Apps before the next Vercel Pro
billing period, which begins **November 7, 2026**. It also amends `AGENTS.md`
with a new hard-rule section 20.

Nothing is provisioned, deployed, configured, or changed:

- no Azure resources, deployments, or configuration changes;
- no DNS, secret, Vercel, or repository-setting changes;
- no API calls, and no production access.

Every execution step below is founder-only.

- **Base:** `master@998e6cc`.
- **Pending and independent:** draft PRs #26 (005E), #27 (005F), and #28
  (005G).
- **Prerequisite:** the Gate 003T fast-scan fix (branch
  `gate-003t-fast-scan-persistence-fail-safe`, `291d81f`, pushed for review
  under this approval).

## 1. Decision: two phases

- **Phase 1 (by November 7): hosting only.** The same application, with the
  same code paths, runs as a container on Azure Container Apps. It
  **temporarily keeps**:
  - Supabase, for authentication and data, through `lib/data`;
  - Inngest, for the slow scan path.

  DNS moves `checkbeforeclick.com` to Azure, and Vercel is retired.
- **Phase 2 (after November 7): data, auth, and jobs move to Azure.** This
  covers:
  - the migration 004 apply (Gate 003S) with `cbc_app`;
  - TLS verification (003U);
  - a Postgres `lib/data` adapter and a one-way data migration from Supabase
    (Tokyo) to Azure (Canada Central), together with the 003S decisions D1
    and D4;
  - Microsoft Entra External ID in place of Supabase Auth;
  - Service Bus and a worker in place of Inngest;
  - then retiring Supabase.

**Why split:** Phase 2 is security-critical work (tenant isolation, an auth
redesign, a data migration) spanning several gates. It cannot be done safely
in three weeks, and it is **not needed** to stop paying for Vercel. The
application has no Vercel-specific code and no `vercel.json`. Supabase and
Inngest are reachable from any host.

## 2. Current state (from repository evidence)

| Concern | Today | Phase 1 | Phase 2 target |
| --- | --- | --- | --- |
| Hosting | Vercel (Production from `master`, Preview per branch) | **Azure Container Apps** (Canada Central) | Same |
| Auth | Supabase Auth: `signInWithPassword`, `signUp`, `exchangeCodeForSession`, `proxy.ts` session refresh | Supabase Auth (unchanged) | Entra External ID |
| Data | Supabase PostgreSQL through `lib/data` (service role) | Unchanged | Azure PostgreSQL `pg-cbc-prod-cc-001` |
| Slow path | Inngest `processScan`, served at `/api/inngest` | Inngest (URL now on Azure) | Service Bus and a worker |
| Fast scan | **HTTP 500 on `master`.** The route always calls `recordFastScanResult`, and `CBC_DATABASE_URL` is unset | Fixed by Gate 003T (helper opt-in; Supabase writes by default) | Postgres data layer |
| Secrets | Vercel environment variables | **Key Vault** references through managed identity | Key Vault |

Existing Azure resources, per the 2026-06-19 audit and **unverified now**:

- `rg-cbc-prod-canadacentral-001`;
- `pg-cbc-prod-cc-001` (PostgreSQL 16, with migrations 001 and 002 applied);
- `kv-cbc-prod-cc-001`;
- a $300 monthly budget alert.

The `cbcpgadmin` / Key Vault mismatch remains **off limits**. Phase 1 needs
no database administration.

## 3. Phase 1 hosting architecture

```text
            DNS: checkbeforeclick.com (+ www)  ── founder-managed, provider unverified
                              │
                              ▼
   Container Apps environment  cae-cbc-prod-cc-001  (Consumption, Canada Central)
     ├── ca-cbc-web-prod-cc-001   custom domain + managed cert; min 1 replica
     │      image: crcbcprodcc001.azurecr.io/cbc-web:<sha>-prod
     │      secrets: Key Vault refs via id-cbc-web-cc-001
     │      → Supabase (prod project)   → Inngest (prod env)   → Google Web Risk
     └── ca-cbc-web-stg-cc-001    default *.azurecontainerapps.io FQDN; min 0 replicas
            image: crcbcprodcc001.azurecr.io/cbc-web:<sha>-stg
            → Supabase (staging project) → Inngest (branch env)
   Container registry      crcbcprodcc001  (Basic; pull by managed identity, admin user disabled)
   User-assigned identity  id-cbc-web-cc-001  (AcrPull on registry; Key Vault Secrets User on vault)
   Log Analytics           log-cbc-prod-cc-001 (daily cap)
   Key Vault (existing)    kv-cbc-prod-cc-001  (new secrets added by the founder)
```

- **Proposed names** follow the existing `<type>-cbc-<env>-cc-001`
  convention. The registry name must be alphanumeric. All names are
  final only once the founder accepts them.
- **One Container Apps environment hosts both apps.** That is cheaper, and
  there is no VNet in Phase 1. Staging is fully separated at the
  configuration level: a different Supabase project, an Inngest branch
  environment, and different secrets.
- **The container:**
  - Next.js `output: "standalone"`;
  - a multi-stage Dockerfile pinned to Node `24.14.0`, running as a non-root
    user on port 3000;
  - `npm ci` from the lockfile;
  - a `/api/healthz` route for readiness and liveness probes.

  All of this is built in Gate 006B. Whether lifecycle scripts can be
  skipped, which depends on `sharp` and other native packages, is verified
  there.

## 4. Cost estimate (to be confirmed by the founder in the Azure pricing calculator)

These are approximate list-price assumptions for Canada Central, consumption
plan. They are **unverified**.

| Item | Assumption | Approx. monthly |
| --- | --- | --- |
| Production app | 0.5 vCPU / 1 GiB, 1 always-on replica, after the monthly consumption free grant | about $25–35 (lower if the idle rate applies) |
| Staging app | Scale to zero, used only for smoke tests | about $0–5 |
| Container registry | Basic tier | about $5 |
| Log Analytics | Low volume, daily cap set | about $1–5 |
| Managed certificate, identity | Included | $0 |
| Key Vault operations | Very low | under $1 |
| **Phase 1 increment** | | **about $30–50** |
| Existing PostgreSQL B2s and Key Vault | Already running | about $30–50 (unchanged) |

Context:

- The existing $300 monthly budget alert covers this.
- Microsoft for Startups credits ($1,000, per the audit) offset it.
- The Vercel Pro cost removed is unverified; the founder can check it on the
  Vercel invoice.

## 5. Environment variables (names only; values are never in the repository)

| Name | Kind | Staging | Production | Notes |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public, **build-time** | Staging project URL | Production project URL | Inlined at build, so there is one image per environment |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public, **build-time** | Staging anon | Production anon | Browser-exposed; protected by RLS |
| `NEXT_PUBLIC_APP_URL` | Public, build-time | Unset (origin fallback) | `https://checkbeforeclick.com` | Same as Vercel today |
| `SUPABASE_SERVICE_ROLE_KEY` | **Secret** (Key Vault reference) | Staging service role | Production service role | Legacy; never crosses environments; not deepened (section 12) |
| `GOOGLE_WEB_RISK_API_KEY` | Secret | Shared | Shared | As today |
| `INNGEST_EVENT_KEY` | Secret | Branch environment | Production | Read by the Inngest SDK |
| `INNGEST_SIGNING_KEY` | Secret | Branch environment | Production | Read by the Inngest SDK |
| `INNGEST_ENV` | Plain | Branch environment name | Unset | As in `docs/ENVIRONMENTS.md` |
| `WEB_RISK_PROVIDER_ENABLED`, `DOMAIN_AGE_PROVIDER_ENABLED` | Plain | As today | As today | Copy the current values |
| `NODE_ENV`, `PORT`, `HOSTNAME` | Plain | `production`, `3000`, `0.0.0.0` | Same | Container runtime |
| `CBC_DATABASE_URL`, `CBC_DATABASE_SSL`, `CBC_FAST_SCAN_PERSISTENCE_HELPER` | n/a | **Unset** | **Unset** | Phase 2 only (Gate 003S approval B) |
| `ANTHROPIC_API_KEY` | n/a | Not provisioned | Not provisioned | Listed in `docs/ENVIRONMENTS.md`, but no code reads it |

**Secret handling:** the founder copies values from Vercel into Key Vault,
named for example `cbc-stg-supabase-service-role-key`. Container Apps
reference them with `keyvaultref:` through `id-cbc-web-cc-001`. Agents never
see, print, or handle any value (`AGENTS.md` sections 11 and 20).

## 6. Deployment design (built in Gate 006B; inert until founder setup)

- **Infrastructure as code:** Bicep under `infra/azure/hosting/`, covering
  the registry, Log Analytics, the Container Apps environment, both apps,
  the identity, and role assignments. The founder applies it with
  `az deployment group create … --what-if` first, then for real.
  **Agents never apply it.**
- **Workflow `azure-deploy.yml`:**
  - **trigger:** `workflow_dispatch` only, with inputs for the environment
    (`staging` or `production`) and the commit. **There is no trigger on
    merge**, so a merge never deploys to Azure;
  - **jobs:** a build job with no secrets, then an `azure-<env>` job;
  - **approval:** that GitHub Environment requires the **founder** as
    reviewer;
  - **authentication:** `azure/login` with OIDC through a federated
    credential, so no client secret is stored;
  - **steps:** push the image to the registry, run
    `az containerapp update --image <registry>/cbc-web:<sha>-<env>`, then
    wait for the new revision and check `/api/healthz`;
  - **permissions:** `id-token: write`, `contents: read`.
- **Rollback:** reactivate the previous Container Apps revision and shift
  traffic to it. That is also an approved action in the `azure-<env>`
  environment.
- **Public values:** `NEXT_PUBLIC_*` values come from GitHub Environment
  variables at build time. They are public by definition. Secrets are never
  build arguments.

## 7. Smoke test matrix (run on staging, then on production after cutover)

| # | Check | Expected |
| --- | --- | --- |
| S1 | `GET /api/healthz` | 200 |
| S2 | `GET /` and the login and register pages | 200 and render |
| S3 | Protected route while signed out (`/dashboard`) | Redirect to login (`proxy.ts`) |
| S4 | Register and confirm (if confirmation is enabled), then log in | Session established; dashboard loads |
| S5 | Fast URL scan | 201, `complete`, normalized verdict (**requires 003T**) |
| S6 | Fast domain scan | 201, `complete` |
| S7 | Invalid target (for example `localhost`) | 201, `unknown`, one evidence item |
| S8 | Slow-path scan (email) | 201, then Inngest runs `processScan` against `/api/inngest` on Azure and the scan completes |
| S9 | `GET /api/scan/<id>/status` and the scan page | Matches the POST result |
| S10 | History and watchlist pages | Render for the signed-in user only |
| S11 | Sign out | Session cleared; protected route redirects |
| S12 | Logs | No secrets in Log Analytics; no unhandled errors |

Staging uses the staging Supabase project and the Inngest branch
environment. Production smoke tests use a founder test account; no customer
data is touched.

## 8. DNS and certificate cutover (founder-run)

The DNS provider, the current records, and apex versus `www` usage are
**unverified**. The founder confirms them first.

1. **T−7 days (about October 27):** lower the TTL to 300 seconds on the
   `checkbeforeclick.com` records.
2. **Validation records:** add the Container Apps domain-verification TXT
   records (`asuid…`).
   - For the **apex**, an A record to the environment's static IP is
     prepared; it is not switched yet.
   - For **`www`**, a CNAME to the app's FQDN is prepared.
3. Bind the custom domains to `ca-cbc-web-prod-cc-001` and issue managed
   certificates. Issuance needs the DNS records in place, so plan for a
   short window.
4. **Supabase production auth:** the Site URL stays
   `https://checkbeforeclick.com`, because the domain does not change. Add
   the Azure default FQDN to the redirect URLs only for testing, and remove
   it afterwards. Staging gets the staging app FQDN.
5. **Inngest production:** the app URL `https://checkbeforeclick.com/api/inngest`
   stays the same. After the DNS switch, re-sync the app in Inngest and
   confirm the signing key matches.
6. **Switch:** change the apex and `www` records to Azure. Run smoke tests
   S1–S12 on production. Keep the Vercel project intact.
7. **Rollback:** revert the DNS records to Vercel's values (recorded before
   the switch). With a 300-second TTL, recovery takes minutes.

## 9. Vercel retirement checklist (founder-run, before November 7)

1. Record the Vercel environment variable inventory (names only) and
   confirm every value exists in Key Vault.
2. Confirm production has run on Azure for **48 hours or more** without
   critical errors, and S1–S12 pass.
3. **Disconnect the Vercel Git integration.** This stops all Preview and
   Production builds on pushes, which also removes the "agent push creates
   a preview" concern.
4. Remove `checkbeforeclick.com` from the Vercel project.
5. Cancel or downgrade Vercel Pro before **November 7**, and confirm
   on the next invoice.
6. **Record the retirement** in a docs-only gate. Only after that may the
   founder amend `AGENTS.md` to remove the Vercel-specific rules (section 20
   transition rule).

## 10. Coexistence with pending Gates 005E, 005F and 005G

- **No file overlap with the hosting work:**
  - 006A changes only `AGENTS.md` (section 1's list of hard-rule sections,
    plus a new section 20) and this document;
  - 006B will add `infra/azure/hosting/**`, a Dockerfile, a
    `.dockerignore`, `azure-deploy.yml`, a health route, and the
    `next.config.ts` output setting.
- **Checked:** the 006A `AGENTS.md` change merges **cleanly** with PR #27's
  `AGENTS.md` (`git merge-tree`, no conflict). Section 20 is new, and the
  section 1 line is untouched by #27.
- **005E** (`state-reconcile.yml`, on push to `master`) is read-only
  checking. It is unaffected by Azure deployments.
- **005F** keeps its Vercel rules, as section 20 requires. Its automation
  actor (section 6.6) **cannot** deploy to Azure, approve an
  `azure-*` environment, or change Azure resources. The reviewer's findings
  that mention deploying are escalated to the founder by the Gate 005A
  orchestrator.
- **005G's `CBC_VERCEL_POLICY_VERIFIED` precondition:**
  - Until Vercel is retired, it still means the Vercel policy in 005F
    section 6.
  - After retirement, disconnecting Vercel's Git integration satisfies the
    "agent pushes create no deployments" goal on its own, so a later gate
    can rename it to a hosting-neutral `CBC_DEPLOY_POLICY_VERIFIED`.
  - The Azure workflow is dispatch-only, so agent branch pushes never
    deploy.
- **Order:** the migration gates do not depend on 005E, 005F, or 005G. Those
  can remain draft until after cutover, or proceed independently. Manual
  review (as proven in 005B) suffices for the migration gates.

## 11. Gate sequence and dates

| Window | Gate | Owner |
| --- | --- | --- |
| Oct 16–18 | **006A** (this gate): plan and section 20 | Claude drafts; founder approves and merges (**a merge is a Vercel production deployment**) |
| Oct 17–20 | **003T**: fast-scan fix review and merge | Founder merges (**a Vercel production deployment, which fixes the current HTTP 500**) |
| Oct 19–23 | **006B**: container, Bicep, deploy workflow, health route, local container validation | Claude |
| Oct 23–26 | Provisioning (section 12) | Founder |
| Oct 26–29 | **006C**: first staging deployment and smoke tests S1–S12 | Founder approves the deployment; Claude analyzes the results |
| Oct 27 | Lower the DNS TTL | Founder |
| Oct 30–Nov 3 | **006D**: production deployment, DNS cutover, smoke tests | Founder |
| Nov 3–6 | Vercel retirement (section 9) | Founder |
| After Nov 7 | Phase 2 gates; resume 005E–005H | |

## 12. Founder-only actions (none performed here)

1. Approve and merge 006A and 003T, acknowledging that each merge is a
   Vercel production deployment.
2. **Azure access:** confirm the subscription, the resource group, and that
   the founder holds Owner or User Access Administrator rights.
3. **Provision:** review the Bicep `what-if` output, then apply it (from
   006B).
4. **Deploy identity:**
   - create the Entra app registration with federated credentials for this
     repository's `azure-staging` and `azure-production` environments;
   - grant the deploy identity the minimum role on the resource group, plus
     `AcrPush`.
5. **Key Vault:**
   - add the section 5 secrets, copied from Vercel;
   - grant `id-cbc-web-cc-001` the Key Vault Secrets User role;
   - do not touch the `cbcpgadmin` item.
6. **GitHub:**
   - create the `azure-staging` and `azure-production` Environments, with
     the founder as required reviewer;
   - add the non-secret variables: Azure client, tenant, and subscription
     IDs, the registry name, and the public `NEXT_PUBLIC_*` values per
     environment.
7. **Supabase:** add staging and production redirect URLs for the Azure
   FQDNs used in testing.
8. **Inngest:** re-sync the staging and production app URLs after
   deployment.
9. **DNS:**
   - identify the provider;
   - lower the TTL;
   - add the validation records;
   - switch the records;
   - keep a record of the Vercel values for rollback.
10. **Vercel:** carry out the retirement checklist (section 9).
11. **Budget:** keep the $300 alert; optionally add an alert for the hosting
    resources.

## 13. Assumptions and what cannot be verified from the repository

| Item | Status |
| --- | --- |
| The current state of Azure resources and the founder's access rights | Unverified. The last evidence is the 2026-06-19 audit |
| Whether `CBC_DATABASE_URL` is unset in Vercel Production, so live fast scans return 500 | Unverified live. It follows from the code and `docs/ENVIRONMENTS.md` |
| The DNS provider, current records, apex vs `www`, and DNSSEC | Unverified |
| Vercel plan price, billing date, other projects, and any extra Vercel features (such as Analytics) | Unverified. No Vercel SDK appears in the code |
| Supabase Auth settings (email confirmation, providers) and redirect lists | Unverified. The code uses email and password only |
| Inngest app configuration and keys | Unverified |
| Next.js 16 `standalone` output and `proxy.ts` running in a Node container; whether `sharp` and native packages need lifecycle scripts | Verified in Gate 006B by a local container build |
| The cost figures in section 4 | Estimates. The founder confirms them in the Azure pricing calculator |
| Latency from Canada Central to the Supabase project in Tokyo | Acceptable for Phase 1 (no customers, per the docs); measured in 006C |

## 14. Validation (this gate)

- `AGENTS.md` and this document only.
- `git diff --check`, `npm run build`, and YAML parsing of `.agents/*.yaml`.
- The `git merge-tree` check against PR #27 is clean.

## Out of scope

- Any Azure, DNS, Vercel, Supabase, Inngest, GitHub-settings, or secret
  change.
- Any deployment or code change. Container, IaC, and workflow work belong
  to Gate 006B.
- Phase 2.
