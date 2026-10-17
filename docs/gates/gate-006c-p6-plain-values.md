# Gate 006C - P6: Phase B plain values (parameters file)

## Status

**Prepared offline. Nothing applied.** This fills the six `REPLACE_WITH_`
placeholders in `infra/azure/hosting/main.parameters.json`. The values only
take effect at a future, founder-authorized Phase B what-if and create (B6/B7).
No Azure, GitHub, Supabase, Inngest or Vercel setting was changed, and no secret
was read or written.

- **Authorization:** the founder approved Gate 006C Phase B configuration
  preparation (steps 1 and 2 of the Phase B prerequisite sequence), 2026-10-17.
- **Verification:** the founder verified the Vercel and Inngest facts below in
  their dashboards (screenshots reviewed by ChatGPT). Claude Code had no
  dashboard access.

## Values and sources of truth

| Placeholder (environment) | Value | Source of truth |
| --- | --- | --- |
| `INNGEST_SERVE_ORIGIN` (staging) | `https://ca-cbc-web-stg-cc-001.lemonmeadow-5efc7b91.canadacentral.azurecontainerapps.io` | B5 deployment output `stagingPublicOrigin` (`docs/gates/gate-006c-b4-b5-results.md`) |
| `INNGEST_ENV` (staging) | `audit/azure-current-state` | Founder-verified active Inngest branch environment (2026-10-17). It is also the Vercel Preview value (`docs/ENVIRONMENTS.md` §3 and §10) |
| `WEB_RISK_PROVIDER_ENABLED` (staging) | **omitted** | Founder-verified: unset in Vercel Preview |
| `DOMAIN_AGE_PROVIDER_ENABLED` (staging) | **omitted** | Founder-verified: unset in Vercel Preview |
| `WEB_RISK_PROVIDER_ENABLED` (production) | **omitted** | Founder-verified: unset in Vercel Production |
| `DOMAIN_AGE_PROVIDER_ENABLED` (production) | **omitted** | Founder-verified: unset in Vercel Production |

The founder also verified that no shared environment variables are linked in
either Vercel environment.

**Why the flags are omitted instead of set:** `lib/scan/providers/googleWebRisk.ts:114`
and `lib/scan/providers/domainAge.ts:171` enable each provider unless the
variable is exactly `"false"`. Omitting the variable is therefore the exact
equivalent of "unset" in Vercel: both providers stay enabled, as today. The
`plainEnv` arrays are concatenated into the container environment
(`modules/web-app.bicep`), so fewer entries need no template change.

Unchanged:
- production `INNGEST_SERVE_ORIGIN` = `https://checkbeforeclick.com`;
- production does not set `INNGEST_ENV` (it uses the Inngest Production
  environment, as on Vercel);
- `productionMinReplicas` = `0` (P8);
- all secret names (P5a).

## Resulting plain environment variables

- **Staging app:** `INNGEST_ENV`, `INNGEST_SERVE_ORIGIN`, plus `PORT`/`HOSTNAME`
  from the module and the four Key Vault secret references.
- **Production app:** `INNGEST_SERVE_ORIGIN`, plus `PORT`/`HOSTNAME` and the
  four Key Vault secret references.

## Risks

1. **Shared Inngest execution context (temporary).** Azure staging reuses the
   Vercel Preview branch environment `audit/azure-current-state`. Until Vercel
   is retired:
   - runs triggered from Vercel Preview and from Azure staging appear in the
     same branch environment;
   - the Inngest app's served URL is whichever origin synced last, so syncing
     one deployment can redirect function calls to the other.

   Mitigations: after each Azure staging deploy, re-sync the app at
   `<staging origin>/api/inngest` and confirm smoke S8 completes in this branch
   environment; avoid Vercel Preview slow-path tests while Azure staging is
   being validated. No dedicated `azure-staging` Inngest environment is assumed
   to exist. Moving to one later is a separate, founder-approved change.
2. **The provider flags rely on the code default.** If the default in
   `lib/scan/providers/*.ts` ever changes, Azure would follow it without a
   parameters change. The safety test asserts the flags stay absent, so any
   change to that choice is deliberate and reviewed.
3. **The B4 runbook pin is historical.** `docs/gates/gate-006c-b4-whatif-handoff.md`
   pinned the templates to `336fa30`. After this change, `main.parameters.json`
   differs from that pin. B4 is complete; the B6 runbook must pin the commit
   that includes this change.
4. **No effect on Phase A.** With `deployApps=false`, Phase A ignores both
   `*PlainEnv` parameters; the deployed Phase A resources are unaffected.

## Validation

Recorded in the PR and the handoff: Bicep CLI 0.48.1 build and lint, a compiled
ARM parameter check, and the hosting safety test with 7 new P6 checks.
