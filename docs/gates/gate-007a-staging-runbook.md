# Gate 007A - staging runbook ST1–ST8 (PR #45 Preview)

**Founder-executed.** Claude Code wrote this runbook and has made **no** live call against the Preview, Supabase,
Google or Inngest. Running it is the founder's action. Approving this runbook approves nothing else: no merge,
no production action, no migration (AGENTS.md sections 3 and 6.3).

## 0. Facts this runbook relies on

| Item | Value | Source |
| --- | --- | --- |
| Code under test | `42a65d1b4e8987469f48db04238184a866888c04` (draft PR #45; reviewed code head `8042530` plus docs) | git |
| Preview URL | `https://checkbeforeclick-7alirs8a6-checkbeforeclick.vercel.app` | GitHub deployment 7296701791, environment `Preview`, state `success`, 2026-10-24T09:20:17Z |
| Staging Supabase | `zgxmvpbvvakpsnzcymsf` (Preview uses staging per `docs/ENVIRONMENTS.md`) | repo; **verified in P3 below** |
| Migration | `001_scan_admission.sql` applied to staging by the founder on 2026-10-23 | founder-reported |
| Limits | burst 5 scans per user per minute; 50 per user, 200 per org, 500 global per 24 h; login 10 per IP and 5 per email per 15 min (per instance) | `lib/security/rateLimit.ts` |
| Provider deadline | 20 s → 504 `scan_timeout`; route `maxDuration` 30 s | `lib/scan/scanFlow.ts`, `app/api/scan/route.ts` |

If a newer commit lands on the branch, use the Preview of that commit instead and record its SHA.

## 1. Cost and approvals (decide before starting)

- **Paid Google Web Risk requests: 7 in total.**
  - ST2: 4 (url, domain, email with a link, header with a link).
  - ST6: 3 URL scans.
  - Every other step makes **no** paid request: no-link inputs and login calls never reach Web Risk.
- **They use the shared `GOOGLE_WEB_RISK_API_KEY`.** Dossier R1 (quota and budget alert) should be in place
  first.
- **Record your approval** of these 7 requests in the evidence sheet before ST2.
- **ST5 is optional** and needs a Preview environment-variable change plus a redeploy (founder-only). Skip it
  unless you want the kill-switch proof.
- **Your own IP is locked out** of Preview sign-in for 15 minutes after ST1b/ST8. Those steps therefore run
  last.

## 2. Stop conditions (abort and record)

Stop immediately, record the evidence, and do not continue, if any of these happens:
- any HTTP 500 from `/api/scan` or `/api/auth/login`;
- a Web Risk vendor row with `error_message` containing `API error 401` or `API error 403`. That means the
  `X-Goog-Api-Key` header change does not authenticate; it is a **release blocker**;
- more reservation rows than URL-bearing admitted scans, or any reservation for a no-link scan;
- any scan with no link, or with a private or loopback target, getting `verdict = 'safe'`;
- the Preview talking to a Supabase project other than staging (P3);
- an unexpected Google Cloud cost or quota alert.

## 3. Preparation

**P1. Open the Preview** in a normal browser, signed in to Vercel if Deployment Protection asks. Note the time
as `T0` (UTC).

**P2. Test account.** Use the existing staging test user (called **U1** below). Do not paste its email or
password into the evidence sheet or any shared document. Find its id in the staging SQL editor:
```sql
select id, email, last_sign_in_at from auth.users where email = '<U1 email>';   -- keep the email local
```
Record only `U1_ID`.

**P3. Sign in on the Preview with U1 (this is ST1a).**
- Expect the dashboard to open.
- The browser now signs in only through `POST /api/auth/login`. In DevTools → Network, the login request must
  go to `/api/auth/login` and return **200**.
- Then confirm in the staging SQL editor that this Preview really uses staging:
```sql
select last_sign_in_at > now() - interval '5 minutes' as signed_in_just_now from auth.users where id = '<U1_ID>';
```
`true` proves the Preview uses staging. `false` is a stop condition.

**P4. Baseline** (staging SQL editor, as `postgres`; record the four numbers):
```sql
select
  (select count(*) from public.scan_admissions where user_id = '<U1_ID>')            as admissions_u1,
  (select count(*) from public.provider_call_reservations where user_id = '<U1_ID>') as reservations_u1,
  (select count(*) from public.scans where user_id = '<U1_ID>')                       as scans_u1,
  now()                                                                               as baseline_at;
```

All console snippets below run in **DevTools → Console on the Preview tab, signed in as U1**. They only call the
Preview's own `/api/...` routes. If the console refuses pasting, type `allow pasting` first.

## 4. Tests

### ST2: one scan per input type (4 paid requests)

Space the scans about **15 s apart** so the burst limit (5 per minute) cannot interfere. Use the UI for `url`,
`email` and `header` (the tabs "URL or Domain", "Full Email" and "Email Header"), and the console for `domain`.

| # | Type | Input | Expected |
| --- | --- | --- | --- |
| 2a | url (UI) | `https://www.wikipedia.org/` | Result page opens; status complete; verdict `safe` or `unknown`; one Web Risk request |
| 2b | domain (console) | `wikipedia.org` | 201, `status: "complete"`; one Web Risk request |
| 2c | email (UI) | `Hello, please review https://www.wikipedia.org/wiki/Phishing today.` | complete; one Web Risk request on that first link |
| 2d | header (UI) | `List-Unsubscribe: <https://www.wikipedia.org/>` | complete; one Web Risk request |
| 2e | email (UI) | `Hello, please call me about the invoice. No links here.` | complete; verdict **unknown**; **no** Web Risk request |

Console for 2b:
```js
await (async () => {
  const r = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "wikipedia.org", input_type: "domain" }) });
  console.log(r.status, await r.json());
})();
```

SQL after ST2:
```sql
select s.created_at, s.input_type, s.status, s.verdict, s.scan_duration_ms,
       (select count(*) from public.provider_call_reservations r
          join public.scan_admissions a on a.id = r.admission_id
         where a.user_id = s.user_id and r.reserved_at between s.created_at - interval '5 seconds' and s.created_at + interval '30 seconds') as reservations_near
  from public.scans s
 where s.user_id = '<U1_ID>' and s.created_at > '<baseline_at>'
 order by s.created_at;
select count(*) as admissions_since from public.scan_admissions where user_id = '<U1_ID>' and admitted_at > '<baseline_at>';
select count(*) as reservations_since from public.provider_call_reservations where user_id = '<U1_ID>' and reserved_at > '<baseline_at>';
```

Pass conditions:
- 5 scans, all `complete`;
- `admissions_since = 5`;
- `reservations_since = 4`;
- 2e has verdict `unknown` and no reservation near it.

### ST4: the Web Risk header change authenticates (uses the ST2 requests; no extra spend)

```sql
select s.input_type, v.vendor_name, v.verdict, v.error_message, v.response_time_ms
  from public.vendor_results v join public.scans s on s.id = v.scan_id
 where s.user_id = '<U1_ID>' and s.created_at > '<baseline_at>' and v.vendor_name = 'google_web_risk'
 order by s.created_at;
```

Pass conditions:
- 4 rows (2a–2d);
- `verdict` is `clean` or `dangerous`;
- `error_message` is null;
- `response_time_ms` > 0.

An `API error 401/403` is the stop condition from section 2. Any other `error` is recorded and investigated
before release.

### ST3: burst limit (no paid requests)

Wait **60 s** after the last ST2 scan, then:
```js
await (async () => {
  const out = [];
  for (let i = 1; i <= 6; i++) {
    const r = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: `ST3 burst ${i}: no link in this text`, input_type: "email" }) });
    const b = await r.json();
    out.push({ i, status: r.status, reason: b.reason ?? "", retryAfter: r.headers.get("Retry-After"), verdict: b.verdict ?? "" });
  }
  console.table(out);
})();
```

Pass conditions:
- attempts 1–5 return 201 with verdict `unknown`;
- attempt 6 returns **429** with reason `user_burst_limit` and a `Retry-After` of 1–60.

SQL afterwards: admissions rose by 5 more, and reservations by **0**.

The limiter is per instance. If Vercel spreads the six requests across instances, more than 5 can succeed.
Record what you see, re-run once after 60 s, and report both runs. Do not repeat further.

### ST6: latency (3 paid requests)

Wait 60 s after ST3, then:
```js
await (async () => {
  const urls = ["https://www.wikipedia.org/wiki/Main_Page", "https://www.mozilla.org/", "https://www.python.org/"];
  const out = [];
  for (const u of urls) {
    const t = performance.now();
    const r = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: u, input_type: "url" }) });
    const b = await r.json();
    out.push({ url: u, status: r.status, ms: Math.round(performance.now() - t), verdict: b.verdict ?? b.reason });
    await new Promise((res) => setTimeout(res, 15000));
  }
  console.table(out);
})();
```

Pass conditions:
- all three return 201;
- each takes **under 10 s** (target);
- none takes more than 20 s. A 504 `scan_timeout` is a finding to record.

Also record `scan_duration_ms` from SQL for these scans.

### ST7: the Inngest worker is not used (no requests)

In the Inngest dashboard, open the environment that serves this Preview (a branch environment, if Vercel
branch environments are enabled). Filter function `process-scan` and event `scan/requested`, from `T0` until
now.

Pass condition: **0 new runs and 0 new `scan/requested` events.**

### ST5 (optional): kill switch (founder-only environment change)

1. Set `WEB_RISK_PROVIDER_ENABLED=false` for Preview in Vercel, and redeploy this commit's Preview.
2. Run one URL scan (no paid request is expected).
3. Restore the variable and redeploy.

Pass conditions:
- 201;
- verdict is **not** `safe`;
- reservations rose by 0;
- the vendor rows contain no `google_web_risk` row.

If you skip it, record it as "not run (optional)".

### ST1b: login throttle (no paid requests; locks your IP for 15 min, so run it near the end)

1. Sign out (`/auth/signout`).
2. On the Preview login page, use a **non-existent** address, for example `st1-<yyyymmddhhmm>@example.invalid`,
   with any wrong password. Submit it 6 times.

Pass conditions:
- attempts 1–5 show "Invalid email or password.";
- attempt 6 shows "Too many sign-in attempts. Please wait about 15 minutes and try again.";
- in Network, the 6th response is **429** with `Retry-After` and `Cache-Control: no-store`.

Per-instance caveat: if attempt 6 still shows "Invalid", continue up to 10 attempts and record the attempt
number of the first 429.

After that, **wait 15 minutes** before ST8, because both use your IP's bucket. U1 itself is never locked, since
ST1b uses a non-existent address.

### ST8: a forged X-Forwarded-For does not change the IP bucket (no paid requests)

Run this ≥ 15 minutes after ST1b, on the Preview tab. Signing in is not required.
```js
await (async () => {
  const out = [];
  for (let i = 1; i <= 11; i++) {
    const r = await fetch("/api/auth/login", { method: "POST",
      headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${i}` },   // forged, different each time
      body: JSON.stringify({ email: `st8-${i}-${Date.now()}@example.invalid`, password: "wrong-password" }) });
    out.push({ i, status: r.status, retryAfter: r.headers.get("Retry-After") });
  }
  console.table(out);
})();
```

Pass conditions:
- attempts 1–10 return **401**;
- attempt **11** returns **429**.

Each attempt uses a different email and a different forged address, so a 429 at attempt 11 shows that every
attempt counted against your one real IP. If all 11 return 401 because the forged value was trusted (or the
requests were spread across instances), record it and repeat once after 15 minutes. Two all-401 runs are a
**finding** for the client-IP derivation.

## 5. Evidence sheet (copy, fill in, keep secrets out)

```text
Gate 007A staging run - executed by: founder        Date (UTC): ____        T0: ____
Commit / Preview URL: 42a65d1 / https://checkbeforeclick-7alirs8a6-checkbeforeclick.vercel.app
Approval of 7 paid Web Risk requests (ST2 x4, ST6 x3): yes / no      Google Cloud quota/budget (R1) in place: yes / no
P3 Preview uses staging (signed_in_just_now): true / false
P4 baseline: admissions_u1=__ reservations_u1=__ scans_u1=__ baseline_at=____
ST2: scans complete __/5; admissions_since=__ (exp 5); reservations_since=__ (exp 4); 2e verdict=__ (exp unknown)
ST4: web risk rows=__ (exp 4); verdicts=__; error_message all null: yes/no; any API error 401/403: yes/no
ST3: statuses=__ (exp 201 x5, then 429 user_burst_limit); Retry-After=__; extra admissions=__ (exp 5); extra reservations=__ (exp 0)
ST6: ms=__/__/__ (target <10000 each); scan_duration_ms=__/__/__; any 504: yes/no
ST7: process-scan runs since T0=__ (exp 0); scan/requested events=__ (exp 0)
ST5: not run (optional) / result: __
ST1a: login via /api/auth/login 200: yes/no; dashboard opened: yes/no
ST1b: first 429 at attempt __ (exp 6); message shown: __; Retry-After=__; Cache-Control no-store: yes/no
ST8: first 429 at attempt __ (exp 11); statuses=__
Stop conditions hit: none / ____
Unexpected observations: ____
```

When the sheet is filled in, paste it back. Claude Code will record it in the gate document (dossier R5/R6) as
founder-reported evidence, with the SQL outputs, and will not treat any item as passed without its numbers.
