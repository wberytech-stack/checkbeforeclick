# Environments — CheckBeforeClick

> Single source of truth for how Production and Preview/staging are separated.
> **This document must never contain secret values** — no keys, no tokens, not even
> partial keys. Project refs and URLs only (these are non-sensitive identifiers).

## 1. Purpose & scope

Defines the environment-separation model for CheckBeforeClick: which backend each
deployment talks to, which environment variables carry which values, and the rules
that keep Production and staging from mixing.

It exists because environment confusion is a proven operational risk here (see §6).
Goals:

- Production Vercel → **only** Production Supabase.
- Preview Vercel → **only** staging Supabase.
- Service-role keys never cross environments.
- Background jobs (Inngest) isolated per environment.
- Every shared variable is a documented decision, never an accident.

Scope: Vercel env vars, Supabase Auth URL config (both projects), Inngest
environments, and the verification protocols that confirm isolation holds.

## 2. Environment identifiers

| Environment | Supabase project | Supabase ref | App URL (Vercel frontend) |
|---|---|---|---|
| Production | `checkbeforeclick` | `qnjqwmcsfpmpnvlnomat` | https://checkbeforeclick.com |
| Staging (via Preview) | `checkbeforeclick-staging` | `zgxmvpbvvakpsnzcymsf` | https://checkbeforeclick-git-audit-azure-current-state-checkbeforeclick.vercel.app |

**Supabase backend / API URLs** (distinct from the frontend app URLs above):
- Production Supabase API URL: `https://qnjqwmcsfpmpnvlnomat.supabase.co`
- Staging Supabase API URL: `https://zgxmvpbvvakpsnzcymsf.supabase.co`

**Inngest environments:**
- Production → Inngest **Production** environment (Production env keys).
- Preview → Inngest **branch environment** `audit/azure-current-state` (branch-env keys + `INNGEST_ENV`).

- **Production site:** https://checkbeforeclick.com (Vercel Production, tracks `master`).
- **Clean Preview URL:** https://checkbeforeclick-git-audit-azure-current-state-checkbeforeclick.vercel.app
- **Vercel project:** `checkbeforeclick` (Pro plan).

> **Frontend vs. backend URLs are different things.** The "App URL" is the Vercel
> frontend the user visits. The "Supabase API URL" is the backend the app talks to
> (and the value of `NEXT_PUBLIC_SUPABASE_URL`). Do not confuse the two — mixing them
> up is a source of environment errors.

## 3. Vercel environment variable matrix

Values referenced by *source*, never written here.

| Variable | Production source | Preview source | Sharing allowed? | Risk | Notes |
|---|---|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Prod Supabase API URL (`qnjqwmcsfpmpnvlnomat`) | Staging Supabase API URL (`zgxmvpbvvakpsnzcymsf`) | No — must be split | Low | The backend API URL; drives which DB the app uses |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Prod anon | Staging anon | No — must be split | Low–Med | Browser-exposed; RLS-protected |
| `SUPABASE_SERVICE_ROLE_KEY` | Prod service_role | Staging service_role | **No — never cross** | **HIGH** | Bypasses RLS. See §5. |
| `NEXT_PUBLIC_APP_URL` | https://checkbeforeclick.com | **unset** (origin fallback) | No | Low | See §9. Production-only; Preview uses origin fallback. |
| `INNGEST_EVENT_KEY` | Prod Inngest env event key | Branch-env event key | No — must be split | Med | See §10. Implemented. |
| `INNGEST_SIGNING_KEY` | Prod Inngest env signing key | Branch-env signing key | No — must be split | Med | See §10. Implemented. |
| `INNGEST_ENV` | (absent — defaults to Production env) | `audit/azure-current-state` | Preview-only | Low | Selects the Inngest branch environment. See §10. |
| `ANTHROPIC_API_KEY` | Prod key | Shared (acceptable) | Yes — documented | Low–Med | See §11 |
| `GOOGLE_WEB_RISK_API_KEY` | Prod key | Shared (acceptable) | Yes — documented | Low–Med | See §11 |

> The three Supabase variables and the two Inngest keys are split into separate
> Production-scoped and Preview-scoped entries. Production values reference the
> Production environments; Preview values reference staging / the Inngest branch
> environment.

## 4. Supabase Auth URL matrix

### Production (`checkbeforeclick` / `qnjqwmcsfpmpnvlnomat`)
All three are deliberate, previously-approved entries. Production contains **no**
staging or Preview-branch URLs.

### Staging (`checkbeforeclick-staging` / `zgxmvpbvvakpsnzcymsf`)
Staging contains **no** production URLs. Stale debug-branch URL removed during cleanup.

> When a Preview branch is deleted, remove its corresponding staging Redirect URL.

## 5. Service-role key policy

`SUPABASE_SERVICE_ROLE_KEY` is **HIGH risk** — it **bypasses Row-Level Security** and
can read/write any tenant's data.

- **Never** copy the Production service-role key into Preview.
- **Never** copy the staging service-role key into Production.
- Production service-role = Production scope only (`qnjqwmcsfpmpnvlnomat`).
- Preview service-role = Preview scope only (`zgxmvpbvvakpsnzcymsf`).
- Any change to a service-role key is a **dual-review gate** item.
- After any service-role change, **verify by behavior** (§6) — not by visually
  comparing the value.

## 6. Incident lesson (why verify-by-behavior)

A Preview `/dashboard <-> /login` redirect loop was traced to a **malformed/truncated
Preview `SUPABASE_SERVICE_ROLE_KEY`** (missing one character). The server-side service
client could not authenticate, the dashboard's `public.users` read returned 401, and
the app looped to login.

Lessons:

- A truncated key looks almost identical to a correct one. **Visual inspection of
  env-var values is not sufficient.**
- The defect surfaced only under real request behavior (a 401 on `/rest/v1/users`).
- **Behavioral verification is required** after any service-role / Supabase / Inngest
  env change: perform a real signup/login/scan and confirm it works and routes to the
  correct environment.

## 7. Preview isolation verification protocol

1. On a Preview deployment, **sign up a new test user** and run a scan.
2. Confirm it created a **staging** auth user + organization row + `public.users` row,
   and the scan row landed in staging (`zgxmvpbvvakpsnzcymsf`).
3. For a slow-path scan (email/header), confirm the **Inngest run executed in the
   branch environment** (`audit/azure-current-state`), not Production.
4. Confirm the browser session cookie is keyed `sb-zgxmvpbvvakpsnzcymsf-auth-token`.

> **Important (post-launch):** Production is a live site with real, ongoing user
> traffic. "Production row counts unchanged" is therefore NO LONGER a reliable
> isolation signal — production counts will grow from organic usage regardless of
> Preview activity. The reliable signals are: (a) which Inngest environment the run
> executes in, (b) which database the scan writes to (staging cookie ref / staging
> row), and (c) whether the test's own timestamps appear in production. Do not be
> alarmed by organic production growth during a test window.

## 8. Production verification protocol

- Production smoke tests run **only** against https://checkbeforeclick.com.
- Production session cookie is keyed `sb-qnjqwmcsfpmpnvlnomat-auth-token`.
- Because production has live traffic, judge isolation by **timestamps and routing**,
  not raw counts (see §7 note). A production change is "ours" only if its timestamp
  matches our action window.

## 9. `NEXT_PUBLIC_APP_URL` policy
Preview relies on `request.nextUrl.origin` fallback (used in
`app/auth/callback/route.ts`). Hardcoding a Preview value risks wrong-origin
auth/callback behavior. Set in Production only.

**Status:** Implemented 2026-06-07. Removed from Preview (Production retains
`https://checkbeforeclick.com`); verified the auth callback stays on the Preview
domain (relative `/dashboard` redirect; request authority = the `.vercel.app`
Preview URL, not `checkbeforeclick.com`).

## 10. Inngest policy

Model: **Inngest Branch Environments** (Path A).
The app code (`inngest/client.ts`, `app/api/inngest/route.ts`) does not hardcode keys
or environment — the Inngest SDK reads them from the environment. So separation is
config-only (no code change). The branch event/signing keys are shared across all
branch environments; `INNGEST_ENV` selects the specific branch environment.

**Status:** Implemented 2026-06-07. Verified by behavior: two slow-path scans on the
Preview produced Inngest runs that **COMPLETED in the `audit/azure-current-state`
branch environment**, with **no** runs in the Production Inngest environment; the
scans wrote to staging DB; production was unaffected (its concurrent growth was
organic, separately-timed real usage — see §7 note).

**Risk carried forward:** a wrong `INNGEST_SIGNING_KEY` would cause silent webhook
validation failure (Preview jobs stop without an obvious error). Always verify a
slow-path scan COMPLETES in the branch environment after any Inngest key change.

**Future enhancement (out of scope, needs code):** for true per-branch isolation
across many Preview branches, set the Inngest client `env` from
`process.env.VERCEL_GIT_COMMIT_REF`. Current setup uses a fixed `INNGEST_ENV` value
suited to single-branch testing.

## 11. Anthropic / Google Web Risk policy

`ANTHROPIC_API_KEY` and `GOOGLE_WEB_RISK_API_KEY` **may remain shared** across
Production and Preview for now.

- **Not** database / tenant-isolation risks (external third-party APIs, not our data).
- They are **cost / quota / abuse** risks — shared usage means Preview testing consumes
  production quota.
- Separate later if quota, billing, or rate-limiting requires it.

## 12. Rules

- **No undocumented `Production + Preview` variables.** Any variable scoped to both
  must have a written justification in this file.
- **No secrets in this document.** Refs and URLs only.
- **No keys pasted into chat** or any shared channel.
- **No production changes without gate review** (dual-review for auth/authz, schema/RLS,
  secrets, service-role keys, Inngest keys, staging->prod promotion, and Vercel env
  changes affecting production).

## 13. Acceptance criteria (close environment-separation phase)

- [x] Vercel Pro active; production healthy; no unintended production changes during upgrade.
- [ ] Vercel inventory complete: all env vars' names + scopes recorded; no extra vars beyond the known set.
- [ ] Three Supabase vars confirmed split (Prod prod-scoped; Preview staging-scoped), verified by behavior.
- [x] `NEXT_PUBLIC_APP_URL` set Production-only / Preview unset. (Done 2026-06-07.)
- [x] Inngest separated via Branch Environments (Preview → branch env; Production → Production env). (Done 2026-06-07; verified by behavior.)
- [x] Anthropic / Web Risk documented as intentionally shared (cost/quota risk).
- [x] Production Auth URLs free of staging/Preview URLs; staging free of production URLs.
- [x] Production redirect URLs documented as intentional-keep with rationale.
- [x] This document reviewed by ChatGPT, then created and committed.
- [ ] Behavioral isolation re-confirmed once after doc/decisions: Preview signup -> staging; production routing/timestamps clean.

## 14. Open follow-ups

- [x] Final content of this document reviewed by ChatGPT.
- [x] File created at `docs/ENVIRONMENTS.md` and committed (docs-only).
- [ ] Confirm no Vercel env vars exist beyond the known set.
- [ ] Record the literal Preview-side scope labels for each variable.
- [x] Implement Preview-unset for `NEXT_PUBLIC_APP_URL` (gated change). — Done 2026-06-07.
- [x] Separate Inngest via Branch Environments; scope Preview keys to branch env. — Done 2026-06-07.
- [ ] Production test user (org/user from RISK-05 smoke test) — retain-labeled or remove carefully (auth + public.users + org together).
- [ ] GitHub Dependabot: 1 moderate vulnerability on default branch — review later.
- [ ] (Optional, needs code) Per-branch Inngest isolation via `VERCEL_GIT_COMMIT_REF`.

## 15. Current implementation status

A clear separation of what is true *now* vs. what is *intended*:

**Implemented now (live, verified):**
- Three Supabase vars split: Production->prod ref, Preview->staging ref (verified by behavior).
- `NEXT_PUBLIC_APP_URL` → Production-only; Preview unset (request-origin fallback). Verified 2026-06-07.
- Inngest → Branch Environments: Preview uses branch-env keys + `INNGEST_ENV`; Production uses Production env keys. Verified by behavior 2026-06-07.
- Production & staging Supabase Auth URL isolation (no cross-environment URLs).
- Service-role key separation in effect (Preview uses corrected staging key).
- Vercel Pro active; production healthy; spend cap + notifications configured.

**Documented target state (decided, NOT yet implemented):**
- (none outstanding — APP_URL and Inngest now implemented.)

**Accepted temporary interim (known, allowed for now):**
- `ANTHROPIC_API_KEY` and `GOOGLE_WEB_RISK_API_KEY` shared (cost/quota risk only).

**Still pending (owed work):**
- Formal Vercel env-var inventory (no extras; literal Preview scope labels).
- Production RISK-05 test user retain/remove decision.
- Dependabot moderate vulnerability review.
- (Optional) per-branch Inngest isolation via code.

---

*This document must not contain secret values. Update it whenever an environment
variable's scope or an Auth URL changes. Last reviewed: 2026-06-07.*