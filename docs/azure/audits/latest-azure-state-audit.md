# Azure Migration Audit: Current State vs Target

**Date:** 2026-06-19
**Branch:** audit/azure-current-state
**Auditor:** Claude Code (read-only)
**Source of truth:** cbc_project_memory (MCP), codebase, live Azure CLI

---

## Executive Summary

CheckBeforeClick is migrating from Supabase/Vercel/Inngest to an Azure-only production stack. The Azure foundation is solid (PostgreSQL + Key Vault deployed, tenant isolation schema applied), but the project is roughly at the halfway point of its gate sequence. The end-of-June cutover target is aggressive given the remaining work: no app code connects to Azure yet, no auth replacement exists, no compute platform is deployed, and zero test coverage makes safe migration risky.

**Gate 002 (Tenant Isolation Production Apply) is COMPLETE at the database level.** The MCP memory status ("open") is stale — `docs/azure/gate-002-production-apply-results.md` documents successful application with evidence.

---

## Current State

### What Exists in Azure (Live)

| Resource | Name | Config |
|----------|------|--------|
| Resource Group | `rg-cbc-prod-canadacentral-001` | Canada Central |
| PostgreSQL Flexible Server | `pg-cbc-prod-cc-001` | PG 16, B2s, 32GB, public access, password auth, TLSv1.3 |
| Key Vault | `kv-cbc-prod-cc-001` | Standard, RBAC, purge-protected, 1 secret |
| Budget | `cbc-monthly-cost-guardrail` | $300/mo (documented, not IaC-managed) |

### What Exists in Codebase

- ARM template for PostgreSQL (matches live state)
- 2 applied migrations: 001 baseline (10 tables) + 002 tenant isolation (memberships, RLS, helper functions)
- Gate 003B validation scripts (disposable DB only)
- 18 Azure planning docs covering gates 002 through 003D
- No Azure SDK usage in application code
- No Dockerfile, no CI/CD, no tests

### What the App Runs On Today

| Concern | Current Provider | Azure Target |
|---------|-----------------|--------------|
| Auth | Supabase Auth | Entra External ID |
| Database | Supabase PostgreSQL (Tokyo) | Azure PostgreSQL (Canada Central) |
| Data access | Supabase JS SDK (service-role) | Direct pg client with `SET LOCAL` context |
| Background jobs | Inngest | Service Bus + Container Apps Jobs |
| Hosting | Vercel | Azure Container Apps |
| Email | Resend | Resend (no change) |
| Payments | Stripe | Stripe (no change) |
| AI | Anthropic SDK | Anthropic SDK (no change) |
| Threat detection | Google Web Risk | Google Web Risk (no change) |

---

## Gate Sequence Status

```
Phase 0A (current-state capture)              COMPLETE
Gate 2A–2D (Azure foundation)                 COMPLETE
Gate 2F (baseline dry-run)                    COMPLETE
Gate 2G/2H (baseline production apply)        COMPLETE
Phase A.1 (tenant isolation code audit)       COMPLETE
Gate 002 (tenant isolation production apply)  COMPLETE  ← MCP says "open" (STALE)
Gate 003A (runtime role runbook)              COMPLETE
Gate 003B (disposable cbc_app validation)     COMPLETE
Gate 003C (scan experience alignment plan)    COMPLETE (design only)
Gate 003D (fast-path function design)         COMPLETE (design only, NO SQL)
Gate 003E (app-code changes)                  NOT STARTED
Gate 004 (controlled cutover)                 NOT STARTED
Gate 005 (Supabase pause)                     NOT STARTED
```

---

## 12-Lens Audit

### 1. Product

| Finding | Impact |
|---------|--------|
| Core product (URL safety scanning) works end-to-end on Supabase/Vercel today | No product regression risk right now |
| Migration does not add product features — it changes infrastructure | Users see no benefit until post-migration features are built |
| End-of-June cutover means a brief service window | Acceptable — zero paying customers confirmed |
| Fast-path scan experience (instant verdict) is architecturally validated but not implemented in Azure path | Product continuity depends on Gate 003D implementation |

### 2. Business

| Finding | Impact |
|---------|--------|
| $1K Microsoft for Startups credits granted; more under review | Runway is finite — cost discipline matters |
| $300/mo budget guardrail in place | Good fiscal control |
| Current Azure spend: ~$30-50/mo (B2s PostgreSQL + Key Vault) | Well under budget |
| No paying customers yet — reduces migration risk but increases urgency to ship | Window of opportunity for clean cutover |
| Supabase pause prompt triggered acceleration strategy | Timeline pressure is external, not self-imposed |

### 3. UX/UI

| Finding | Impact |
|---------|--------|
| Current scan UX is fully functional on Supabase | No UX regression today |
| Gate 003C defines "Bold & Beautiful" UX standard for scan experience | Post-migration UX target is documented |
| Hybrid fast verdict + async deep scan (Option C) chosen | UX continuity preserved — user sees instant result, deep enrichment follows |
| Auth UX will change (Supabase → Entra) | Login/signup flow needs redesign; social login providers may differ |
| No preview/staging environment for Azure path | Cannot demo Azure UX to stakeholders before cutover |

### 4. Security

| Finding | Severity | Detail |
|---------|----------|--------|
| RLS applied to 10 tenant tables on cbc_prod | Good | Database-layer isolation is live |
| All RLS helper functions use SECURITY DEFINER with pinned search_path | Good | Prevents search_path injection |
| Functions fail-closed (NULL session vars = deny) | Good | Safe default |
| Bootstrap function validates user identity match | Good | Prevents impersonation |
| App-layer tenant isolation confirmed (Phase A.1 audit) | Good | Every query org-scoped |
| Password-only auth on PostgreSQL | Medium | No Entra/AD auth; single credential path |
| Public network access on PostgreSQL and Key Vault | Medium | No VNet/private endpoint |
| Single firewall rule (129.224.217.0/24) | Medium | Narrow but static; no dynamic IP handling |
| Key Vault secret has no expiration | Low | No rotation policy |
| Supabase service-role key bypasses all RLS | Medium | Known; eliminated when Supabase is removed |
| `proxy.ts` may not be wired as Next.js middleware | Medium | Route protection needs verification |
| No SSRF in scan endpoint? | Good | `lib/security/urlSafety.ts` blocks private IPs, localhost, encoded IPs |
| No hardcoded credentials in codebase | Good | Clean |

### 5. Architecture

| Finding | Impact |
|---------|--------|
| Clean separation: `lib/data/` is the single data access chokepoint | Migration-friendly — rewrite 2 files for data layer |
| Auth is concentrated in `lib/supabase/` (2 files) + 4 route handlers | Bounded rewrite surface |
| Inngest is isolated to 2 files | Clean replacement path |
| No Azure SDK in codebase | All Azure integration is ahead |
| Dual org-association (`users.organization_id` + `memberships`) | Potential data consistency risk |
| Gate 003D fast-path function exists only as design doc | Blocking dependency — no SQL implementation |
| Two-role model (cbc_app + cbc_worker) designed but neither role exists on production | Roles must be created before traffic can move |
| ARM template uses preview API version (2023-06-01-preview) | Should upgrade to GA before further deployments |
| Key Vault has no IaC | Drift risk — should get an ARM template |

### 6. Database

| Finding | Impact |
|---------|--------|
| cbc_prod has correct schema (10 tables + memberships + RLS) | Foundation is solid |
| Production DB is currently EMPTY (0 orgs, 0 users, 0 scans) | Data migration from Supabase still needed (Gate 003D) |
| No migration version tracking table | Risk of re-applying or skipping migrations |
| Gate 002 grants cbc_app broad DML; Gate 003B narrows it significantly | Grant model not reconciled for production |
| scan_cache excluded from RLS (intentional — global cache) | Correct |
| audit_log is append-only for cbc_app | Good audit trail design |
| Storage auto-grow disabled at 32GB | Could become a problem under load |
| 7-day backup retention, no geo-redundancy | Acceptable for pre-revenue, risky for production |
| No cbc_app or cbc_worker roles exist on cbc_prod yet | Must be created before any app connection |

### 7. DevOps

| Finding | Impact |
|---------|--------|
| No CI/CD pipeline exists | All deployments are manual |
| No Dockerfile exists | Cannot deploy to Container Apps without one |
| No GitHub Actions workflows | No automated testing, linting, or deployment |
| No infrastructure-as-code for Key Vault or budget | Partial IaC coverage |
| ARM template exists for PostgreSQL only | Single resource is IaC-managed |
| No staging/preview environment on Azure | Cannot test Azure path without production resources |
| Supabase export script exists (`scripts/audit/export-supabase-baseline.ps1`) | Good — data migration tooling started |

### 8. Code Quality

| Finding | Impact |
|---------|--------|
| Zero test files exist (no *.test.*, *.spec.*, no test config) | **Critical** — no safety net for migration rewrites |
| TypeScript strict mode enabled | Good baseline |
| Small codebase (~19 source files + 13 components) | Manageable rewrite surface |
| Dead code in `scanHelpers.ts` (legacy single-provider helpers) | Minor cleanup needed |
| `proxy.ts` naming/export convention may not match Next.js middleware wiring | Needs investigation |
| Org-scoping consistently enforced in data layer | Strong |
| SSRF protection is thorough | Strong |
| No linting configuration visible | Unknown code style enforcement |

### 9. Compliance

| Finding | Impact |
|---------|--------|
| Data residency: Supabase is in Tokyo, Azure target is Canada Central | Geographic data move — may affect latency or compliance claims |
| No privacy policy or terms of service references in codebase | Needed before customer-facing launch |
| Tenant isolation is strong (app + DB layers) | Good for multi-tenant compliance |
| No PII handling documentation | Should exist before processing user data at scale |
| Key Vault purge protection enabled | Meets data protection requirements |
| No secret rotation policy | Should be established |
| Password stored in Key Vault (not in code) | Good practice |

### 10. Investor

| Finding | Impact |
|---------|--------|
| Azure migration demonstrates infrastructure maturity | Positive signal |
| Microsoft for Startups credits reduce burn | Extends runway |
| Gate-based migration methodology is disciplined | Shows engineering rigor |
| No paying customers yet | Revenue validation pending |
| End-of-June target is ambitious but documented | Shows urgency without recklessness |
| MCP-based project memory is innovative coordination approach | Differentiator for AI-assisted delivery |
| Zero test coverage | Red flag for code quality maturity |
| No CI/CD | Red flag for deployment reliability |

### 11. Customer Support

| Finding | Impact |
|---------|--------|
| No customers currently using the product | No support burden during migration |
| Auth system change (Supabase → Entra) | Future users will use different login flows |
| Data residency change (Tokyo → Canada Central) | May affect latency for some users |
| Offline cutover strategy documented | No complex dual-write support scenarios |
| No monitoring or alerting configured on Azure | Post-cutover support will lack visibility |

### 12. Stakeholder Impact

| Stakeholder | Impact | Risk |
|-------------|--------|------|
| End users | None currently (no customers) | Low |
| Developer (sole) | Heavy rewrite workload ahead | Medium — burnout risk |
| Investors | Positive (infrastructure maturity) | Low |
| Microsoft (credits) | Usage validates partnership | Low |
| Supabase | Planned sunset; pause prompt accelerated timeline | Low |

---

## Critical Gaps

| # | Gap | Category | Blocking? |
|---|-----|----------|-----------|
| G1 | Gate 003D SQL implementation does not exist (design only) | Architecture | **Yes** — blocks all subsequent gates |
| G2 | No Azure/Postgres adapter in app code | Architecture | **Yes** — blocks cutover |
| G3 | No Entra External ID setup or auth replacement | Security/Architecture | **Yes** — blocks cutover |
| G4 | No Dockerfile or containerization | DevOps | **Yes** — blocks Container Apps deployment |
| G5 | No CI/CD pipeline | DevOps | **Yes** — blocks safe deployment |
| G6 | Zero test coverage | Code Quality | **Yes** — blocks safe migration validation |
| G7 | No Container Apps deployed | Infrastructure | **Yes** — blocks cutover |
| G8 | cbc_app / cbc_worker roles not created on cbc_prod | Database | **Yes** — blocks app connection |
| G9 | Key Vault has no ARM template | DevOps | No — functional but not IaC-managed |
| G10 | MCP memory Gate 002 status is stale | Coordination | No — cosmetic but should be corrected |
| G11 | No staging environment on Azure | DevOps | Medium — cannot validate before production |
| G12 | `proxy.ts` middleware wiring unverified | Security | Medium — route protection may not be active |

---

## Active Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| End-of-June cutover timeline is aggressive | High | 6+ blocking gaps remain; reassess timeline after Gate 003D implementation |
| Zero test coverage during auth/data layer rewrite | High | Write integration tests before rewriting Supabase → Azure adapters |
| Public network access on production PostgreSQL | Medium | Add VNet integration before customer traffic |
| Password-only PostgreSQL auth | Medium | Enable Entra auth on PostgreSQL alongside Entra External ID |
| Single developer executing migration | Medium | Gate-based methodology + MCP coordination reduce bus-factor risk |
| Data migration from Supabase not yet designed | Medium | Small dataset (3 orgs, 75 scans) — low volume but needs a validated process |
| No monitoring/alerting on Azure | Medium | Deploy App Insights + Log Analytics before cutover |

---

## Blockers

1. **Gate 003D implementation** — the `app_record_fast_scan_result()` function design exists but no SQL migration has been written. This is the critical-path blocker.
2. **No test infrastructure** — rewriting auth and data layers without tests is unsafe.
3. **No Dockerfile** — cannot deploy to Azure Container Apps.
4. **No Entra External ID** — auth replacement is not started.

---

## Gate 002 Production Apply: Status

**COMPLETE.** Evidence in `docs/azure/gate-002-production-apply-results.md`:
- Migration 002 applied to cbc_prod (commit `19119b4`)
- memberships table created, RLS enabled on 10 tables, 6 helper functions installed
- Temporary validation role tested and dropped
- Production DB was empty at apply time (no data risk)

The MCP memory status showing "open" is **stale** and should be corrected.

---

## Recommended Next Steps

1. **Correct MCP memory**: Update Gate 002 status to "passed" with evidence reference
2. **Implement Gate 003D SQL**: Write `app_record_fast_scan_result()` migration + validation scripts
3. **Add test infrastructure**: Set up vitest/jest, write integration tests for data layer and auth
4. **Create Dockerfile**: Containerize Next.js app for Container Apps
5. **Set up CI/CD**: GitHub Actions for lint, type-check, test, build
6. **Reassess timeline**: End-of-June cutover is unlikely given 6+ blocking gaps; set realistic milestone
7. **Investigate `proxy.ts`**: Verify Next.js middleware is actually wired for route protection

---

## Recommended Next Gate

**Gate 003D Implementation** — Write the `app_record_fast_scan_result()` SQL migration, validate on disposable DB, then progress to Gate 003E (app-code adapter changes). This unblocks the entire remaining gate chain.

In parallel: establish test infrastructure and CI/CD (these are not gated but are prerequisites for safe execution of Gates 003E through 005).
