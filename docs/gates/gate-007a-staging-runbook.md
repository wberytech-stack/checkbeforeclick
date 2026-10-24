# Gate 007A - staging runbook ST1–ST8 (PR #45 Preview)

**Founder-executed.** Claude Code wrote this runbook and has made **no** live call against the Preview, Supabase,
Google or Inngest. Running it is the founder's action. Approving this runbook approves nothing else: no merge,
no production action, no migration (AGENTS.md sections 3 and 6.3).

**What it cannot complete.** Release items R1, R5, R6 and R10 are **not** completed by this runbook existing,
or by green CI. Each needs the recorded evidence described here (R5/R6) or its own founder check (R1, R10).

Revision 2 (2026-10-24) addresses the review of `c6a8a97` (PR #45 review, 2026-10-24T09:31Z). See section 7.

## 0. Facts this runbook relies on

| Item | Value | Source |
| --- | --- | --- |
| Code under test | application code of `8042530` (independently reviewed: recommend_approve). Later commits change docs only | git |
| Preview URL | any Preview built from a commit at or after `8042530` on this branch, e.g. `https://checkbeforeclick-7alirs8a6-checkbeforeclick.vercel.app` (`42a65d1`) or `https://checkbeforeclick-kkakwno9a-checkbeforeclick.vercel.app` (`c6a8a97`). Record the URL and its commit | GitHub deployment records, state `success` |
| Staging Supabase | `zgxmvpbvvakpsnzcymsf` (Preview uses staging per `docs/ENVIRONMENTS.md`) | repo; **verified in P3 below** |
| Migration | `001_scan_admission.sql` applied to staging by the founder on 2026-10-23 | founder-reported |
| Limits | burst 5 scans per user per minute; 50 per user, 200 per org, 500 global per 24 h; login 10 per IP and 5 per email per 15 min | `lib/security/rateLimit.ts` |
| Where each limit lives | burst and login: **in memory, per server instance**; daily caps and Web Risk reservations: **in the database, shared** | same |
| Provider deadline | 20 s → 504 `scan_timeout`; route `maxDuration` 30 s | `lib/scan/scanFlow.ts`, `app/api/scan/route.ts` |
| Schema linkage | every reservation row carries the `admission_id` that funded it (at most one per admission). A **scan row has no `admission_id` column**, so scan ↔ admission is matched by order and time only | `001_scan_admission.sql`, `lib/data/index.ts` |

## 1. Paid Google Web Risk requests: hard cap 7

- **Authorized maximum: 7 paid requests** for the whole run, once approved in the evidence sheet:
  - ST2: 4 (2a url, 2b domain, 2c email with a link, 2d header with a link);
  - ST6: 3 URL scans.
  - Every other step makes **no** paid request: no-link inputs and login calls never reach Web Risk. ST5, if
    run, is expected to make none.
- **Anything beyond the 7 is NOT authorized by this runbook.** That covers:
  - retrying or re-running ST2 or ST6;
  - any extra scan whose input contains a link or a domain;
  - any ST5 result that shows a Web Risk row.

  Each of these needs a **new approval recorded in the evidence sheet** (date, count, reason) **and a fresh
  quota check** (R1) before it is sent.
- **The ledger is the counter.** After ST2 and again after ST6, run the cap check (section 3, P5). Stop if
  `reservations_since` exceeds the approved running total: 4 after ST2, 7 after ST6.
- **R1 comes first.** Google Cloud quota and budget alert must be in place, and confirmed on the day, before
  the first paid step (ST2).
- **Your own IP is locked out** of Preview sign-in for 15 minutes after ST1b/ST8. Those steps run last.

## 2. Stop conditions (abort and record)

Stop immediately, record the evidence, and do not continue, if any of these happens:
- any HTTP 500 from `/api/scan` or `/api/auth/login`;
- a Web Risk vendor row with `error_message` containing `API error 401` or `API error 403`. That means the
  `X-Goog-Api-Key` header change does not authenticate; it is a **release blocker**;
- the cap check finds more reservations than approved, any reservation funded by a no-link admission, or any
  reservation without its admission;
- any scan with no link, or with a private or loopback target, getting `verdict = 'safe'`;
- P3a or P3b failing: the Preview is not proven to be bound to the staging Supabase project;
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

**P3. Sign in on the Preview with U1 (this is ST1a), then prove the Preview is bound to staging.**

P3 passes only if **both** project-specific checks, P3a and P3b, pass. Neither reads or copies a credential: P3a
records a cookie **name** only, and P3b uses a random marker you type.

- **ST1a: sign in.**
  - Sign in on the Preview login page as U1. Expect the dashboard to open.
  - In DevTools → Network, the login request must go to `/api/auth/login` and return **200**.
- **P3a: the server's configured project ref.**
  - Where to look: DevTools → Application → Cookies → the Preview origin.
  - Expected: a cookie **named** `sb-zgxmvpbvvakpsnzcymsf-auth-token`. A large session may be split into
    `sb-zgxmvpbvvakpsnzcymsf-auth-token.0`, `.1`, … instead.
  - **Record only the name; never copy its value.**
  - Why this is project-specific: the route sets this cookie through `@supabase/ssr` 0.10.3. That library names
    the cookie `sb-<first label of the Supabase hostname>-auth-token`, derived from the server's
    `NEXT_PUBLIC_SUPABASE_URL` (supabase-js 2.106.1). The app sets no `cookieOptions.name` override.
  - Any other ref, or no `sb-…-auth-token` cookie at all, is a **stop condition**.
- **P3b: a unique write lands in staging (no paid request; the input has no link).**
  - **Mint a marker in the console.** It prints the marker locally:
    ```js
    const P3_MARKER = "p3-" + crypto.randomUUID(); console.log(P3_MARKER);
    ```
  - **Send one scan carrying it:**
    ```js
    await (async () => {
      const r = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: `P3 staging binding check ${P3_MARKER} (no link in this text)`, input_type: "email" }) });
      console.log(r.status, await r.json());   // expect 201 with a scan_id and verdict "unknown"
    })();
    ```
  - **Then, in the staging SQL editor**, paste the printed marker:
    ```sql
    select id, user_id, status, verdict, created_at from public.scans
     where raw_input like '%<P3_MARKER>%';
    ```
  - **Pass:** exactly 1 row, whose `id` equals the `scan_id` the console printed and whose `user_id` equals
    `U1_ID`.
  - **No row is a stop condition:** the Preview did not write to staging.
  - This check uses one admission and makes no Web Risk request. It happens before the P4 baseline, so it does
    not affect later counts.
- **P3c: corroboration only.** On its own this is not proof.
  ```sql
  select last_sign_in_at > now() - interval '15 minutes' as signed_in_recently from auth.users where id = '<U1_ID>';
  ```
  Expected `true`.
- **P3d: optional third view.** In the Vercel dashboard (Project → Settings → Environment Variables), the
  **Preview** value of `NEXT_PUBLIC_SUPABASE_URL` should have the host `zgxmvpbvvakpsnzcymsf.supabase.co`.
  - This is a public value. Do not open, copy or screenshot any other variable.
  - Branch-specific overrides, if any, take precedence. The cookie name (P3a) is what the running deployment
    actually used.
- **Wait 60 s after P3b before ST2,** so the P3b scan cannot count toward ST2's burst window.

**P4. Baseline** (staging SQL editor, as `postgres`; record the values):
```sql
select
  (select count(*) from public.scan_admissions where user_id = '<U1_ID>')            as admissions_u1,
  (select count(*) from public.provider_call_reservations where user_id = '<U1_ID>') as reservations_u1,
  (select count(*) from public.scans where user_id = '<U1_ID>')                       as scans_u1,
  now()                                                                               as baseline_at;
```

**P5. Exact ledger check** (reused after ST2, ST3 and ST6). One row per admission since the baseline, linked to
the reservation it funded **by `admission_id`** (exact, not a time window):
```sql
select a.id as admission_id, a.input_type, a.admitted_at, r.id as reservation_id, r.reserved_at
  from public.scan_admissions a
  left join public.provider_call_reservations r
         on r.admission_id = a.id and r.provider = 'google_web_risk'
 where a.user_id = '<U1_ID>' and a.admitted_at > '<baseline_at>'
 order by a.admitted_at;

-- cap and integrity, same window
select
  (select count(*) from public.provider_call_reservations r
    where r.user_id = '<U1_ID>' and r.reserved_at > '<baseline_at>')                    as reservations_since,
  (select count(*) from public.provider_call_reservations r
    left join public.scan_admissions a on a.id = r.admission_id
    where r.user_id = '<U1_ID>' and r.reserved_at > '<baseline_at>' and a.id is null)   as reservations_without_admission,
  (select count(*) from (select admission_id from public.provider_call_reservations
     where user_id = '<U1_ID>' and reserved_at > '<baseline_at>'
     group by admission_id having count(*) > 1) d)                                       as admissions_with_two_reservations;
```

**What P5 proves.**
- Exactly which admissions funded a Web Risk request, and that none funded two.
- `reservations_since` equals the number of paid requests the code reserved. The reservation is made
  immediately before each request, and no request is made without one.

**What P5 cannot prove.** Which scan row an admission belongs to: the schema has no link. That match is by order,
because the steps run one at a time and 15 s apart.

All console snippets below run in **DevTools → Console on the Preview tab, signed in as U1**. They only call the
Preview's own `/api/...` routes. If the console refuses pasting, type `allow pasting` first.

## 4. Tests

### ST2: one scan per input type (paid requests 1–4 of 7)

Space the scans about **15 s apart**. Run each **once**: a retry is a new paid request (section 1). Use the UI for
`url`, `email` and `header`, and the console for `domain`.

| # | Type | Input | Expected |
| --- | --- | --- | --- |
| 2a | url (UI) | `https://www.wikipedia.org/` | Result page; status complete; verdict `safe` or `unknown`; funds 1 reservation |
| 2b | domain (console) | `wikipedia.org` | 201, `status: "complete"`; funds 1 reservation |
| 2c | email (UI) | `Hello, please review https://www.wikipedia.org/wiki/Phishing today.` | complete; funds 1 reservation (its first link) |
| 2d | header (UI) | `List-Unsubscribe: <https://www.wikipedia.org/>` | complete; funds 1 reservation |
| 2e | email (UI) | `Hello, please call me about the invoice. No links here.` | complete; verdict **unknown**; **no** reservation |

Console for 2b:
```js
await (async () => {
  const r = await fetch("/api/scan", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "wikipedia.org", input_type: "domain" }) });
  console.log(r.status, await r.json());
})();
```

After ST2, run **P5** and this scan list:
```sql
select created_at, input_type, status, verdict, scan_duration_ms
  from public.scans where user_id = '<U1_ID>' and created_at > '<baseline_at>' order by created_at;
```

Pass conditions:
- P5 lists exactly **5 admissions**, in order `url`, `domain`, `email`, `header`, `email`;
- `reservation_id` is **non-null for the first four** and **null for the fifth** (2e). This is exact, by
  `admission_id`;
- `reservations_since = 4`, `reservations_without_admission = 0`, `admissions_with_two_reservations = 0`;
- 5 scan rows, all `complete`; 2e has verdict `unknown`.

### ST4: the Web Risk header change authenticates (uses the ST2 requests; no extra spend)

```sql
select s.created_at, s.input_type, v.verdict, v.error_message, v.response_time_ms
  from public.vendor_results v join public.scans s on s.id = v.scan_id
 where s.user_id = '<U1_ID>' and s.created_at > '<baseline_at>' and v.vendor_name = 'google_web_risk'
 order by s.created_at;
```

Pass conditions:
- 4 rows (2a–2d);
- `verdict` is `clean` or `dangerous`;
- `error_message` is null;
- `response_time_ms` > 0.

An `API error 401/403` is the stop condition from section 2.

**What ST4 proves:** Google accepted the key sent in `X-Goog-Api-Key` for these requests. **What it cannot prove:**
anything about R1 (quota and budget). That is checked separately in Google Cloud.

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
- attempt 6 returns **429** with reason `user_burst_limit` and a `Retry-After` of 1–60;
- P5 shows the new admissions with **null** `reservation_id`;
- `reservations_since` is unchanged (still 4).

**What a pass proves:** the burst limiter works on the instance or instances that served these six requests,
and a burst rejection consumes no admission.

**What it does not prove:**
- a global per-user limit across instances. The limiter is in memory, per instance. With *k* concurrent
  instances a user can make up to 5 × *k* scans per minute;
- anything about the daily caps. Those are enforced in the database, shared across instances, and covered by
  the disposable-database validation.

If more than 5 requests succeed, that is the documented per-instance behaviour, not a defect of this run. Record
it, re-run once after 60 s, and report both runs.

### ST6: latency (paid requests 5–7 of 7)

Wait 60 s after ST3. Run **once**; a re-run needs a new approval (section 1).
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
- none takes more than 20 s (a 504 `scan_timeout` is a finding);
- P5 afterwards shows `reservations_since = 7`, three more reserved `url` admissions, and both integrity
  counts at 0.

Also record `scan_duration_ms` from the scan list.

### ST7: the Inngest worker is not used (no requests)

In the Inngest dashboard, open the environment that serves this Preview. Filter function `process-scan` and event
`scan/requested` from `T0` until now.

Pass condition: **0 new runs and 0 new `scan/requested` events.**

### ST5 (optional): kill switch (founder-only environment change)

1. Set `WEB_RISK_PROVIDER_ENABLED=false` for Preview in Vercel, and redeploy.
2. Run one URL scan.
3. Restore the variable and redeploy.

Pass conditions:
- 201;
- verdict is **not** `safe`;
- P5 shows that admission with a **null** `reservation_id`;
- no `google_web_risk` vendor row.

If a reservation **does** appear, it counts against the cap of 7 and is a finding. If you skip ST5, record it as
"not run (optional)".

### ST1b: login throttle (no paid requests; locks your IP for 15 min, so run it near the end)

1. Sign out (`/auth/signout`).
2. On the Preview login page, use a **non-existent** address, for example `st1-<yyyymmddhhmm>@example.invalid`,
   with any wrong password. Submit it 6 times.

Pass conditions:
- attempts 1–5 show "Invalid email or password.";
- the 6th attempt's **response** (DevTools → Network → `/api/auth/login` → Response) is **429**:
  - body `{"error":"Too many sign-in attempts. Please wait and try again.","retry_after_seconds":<n>}`
    (`lib/security/loginFlow.ts`);
  - headers `Retry-After: <n>` and `Cache-Control: no-store, private`;
- the 6th attempt's **text on the login page** is built by the page from `Retry-After`, not taken from that body:
  "Too many sign-in attempts. Please wait about N minutes and try again." Here N = ⌈`Retry-After` ÷ 60⌉,
  normally 14 or 15 (`app/(auth)/login/[[...rest]]/page.tsx`).

Both texts are expected. A pass needs the 429 body text above, and the page message with an N that matches
`Retry-After`.

**What a pass proves:** the UI signs in through the throttled route, and the per-email limit works on the
instance or instances that served these attempts.

**What it does not prove:**
- a global limit across instances (per-instance memory);
- any protection against direct calls to Supabase Auth with the public anon key. That is Supabase's own rate
  limit and CAPTCHA (R3).

If attempt 6 is still 401, continue up to 10 attempts and record the attempt number of the first 429. Then
**wait 15 minutes** before ST8. U1 itself is never locked.

### ST8: forged client address (no paid requests)

**What this step tests.** A client cannot get a fresh per-IP login bucket by sending its own
`X-Forwarded-For`. It checks the deployed system end to end. It does **not** reveal *where* the forged value was
discarded, at Vercel's edge or in the app. The proxy-hop topology is verified separately (section 5).

**Method A: browser (default).** Run it ≥ 15 minutes after ST1b, on the Preview tab.
- `X-Forwarded-For` is not a forbidden request header in the Fetch standard, so a same-origin `fetch()` sends it.
- **You must confirm that it was actually sent:** in DevTools → Network, open attempt 1 and check that
  **Request Headers** list `x-forwarded-for: 198.51.100.1`.
- If that header is absent, the browser did not send it, and ST8 is **not exercised**, not passed.
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

**Method B: non-browser (only if the Preview has no Vercel Deployment Protection).** Run it from Windows
PowerShell, and **only** against the Preview host. Do not use a protection-bypass secret: if the Preview requires
Vercel authentication, Method B is "not run".
```powershell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$preview = '<Preview URL recorded in the evidence sheet>'   # exactly the Preview under test, nothing else
if ($preview -notmatch '^https://checkbeforeclick-[a-z0-9]+-checkbeforeclick\.vercel\.app$') { throw 'not a checkbeforeclick Preview URL' }
foreach ($i in 1..11) {
  $body = @{ email = "st8b-$i-$(Get-Date -Format yyyyMMddHHmmss)@example.invalid"; password = 'wrong-password' } | ConvertTo-Json
  try {
    $r = Invoke-WebRequest -Uri "$preview/api/auth/login" -Method Post -ContentType 'application/json' -Body $body `
         -Headers @{ 'X-Forwarded-For' = "198.51.100.$i" } -MaximumRedirection 0 -UseBasicParsing
    "$i $($r.StatusCode)"
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { "$i $([int]$resp.StatusCode)" } else { "$i no HTTP response: $($_.Exception.Message)" }
  }
}
```

Pass conditions (either method):
- attempts 1–10 return **401**;
- attempt **11** returns **429**.

Each attempt uses a different email and a different forged address, so a 429 at attempt 11 means every attempt
counted against your one real address.

**What a pass proves:** on the instance or instances that served the run, forged values did not change the IP
bucket.

**What it does not prove:**
- which layer discarded the forged value;
- that limits are global across instances;
- anything about Azure or Front Door (R10).

If all 11 return 401, record it, check that the header was really sent, and repeat once after 15 minutes. Two
all-401 runs with the header confirmed sent are a **finding** for the client-IP derivation. With the header
absent, the run is "not exercised".

## 5. Deployment topology to record (needed to interpret ST3, ST1b and ST8)

Record these from the Vercel dashboard. Values that cannot be seen are recorded as "unknown", never guessed.
- **Plan**, and the **function region** for the Preview.
- **Fluid compute:** on or off.
- **Deployment Protection** on Previews: on or off. This decides whether ST8 Method B is possible.
- **Proxies in front:** whether any proxy or CDN other than Vercel's sits in front of the Preview (expected:
  none).
- **Instance count is not visible to you.** A single-instance pass therefore proves only per-instance
  behaviour.
- **The proxy-hop topology itself is checked by documentation, not by this runbook.** The gate doc cites Vercel's
  statement that it overwrites `X-Forwarded-For` (section "Review round 1 response", item 2). Any other
  topology, such as Azure Front Door, needs its own verification (R10).

## 6. Evidence sheet (copy, fill in, keep secrets out)

```text
Gate 007A staging run - executed by: founder        Date (UTC): ____        T0: ____
Preview URL / commit: ____ / ____
Paid Web Risk approval: max 7 (ST2 x4, ST6 x3) approved: yes / no        R1 quota/budget confirmed today: yes / no
Additional paid approvals (each: date, count, reason, quota re-checked): none / ____
Topology: plan=__ region=__ fluid=__ deployment protection=__ other proxy=__ (unknown allowed)
P3a cookie name(s) seen (name only, no value): ____ (exp sb-zgxmvpbvvakpsnzcymsf-auth-token[.n])
P3b marker row found in staging: yes/no; row id = console scan_id: yes/no; user_id = U1_ID: yes/no
P3c signed_in_recently: true / false        P3d Vercel Preview NEXT_PUBLIC_SUPABASE_URL host: ____ / not checked
P4 baseline: admissions_u1=__ reservations_u1=__ scans_u1=__ baseline_at=____
ST2/P5: admissions in order=__ (exp url,domain,email,header,email); reserved=__ (exp yes,yes,yes,yes,no)
        reservations_since=__ (exp 4); without_admission=__ (exp 0); two_reservations=__ (exp 0)
        scans complete __/5; 2e verdict=__ (exp unknown)
ST4: web risk rows=__ (exp 4); verdicts=__; error_message all null: yes/no; any API error 401/403: yes/no
ST3: statuses=__ (exp 201 x5, then 429 user_burst_limit); Retry-After=__; new admissions unreserved: yes/no; reservations_since=__ (exp 4)
ST6: ms=__/__/__ (target <10000 each); scan_duration_ms=__/__/__; any 504: yes/no; reservations_since=__ (exp 7); integrity 0/0: yes/no
ST7: process-scan runs since T0=__ (exp 0); scan/requested events=__ (exp 0)
ST5: not run (optional) / result: __ (reservation appeared: yes/no)
ST1a: login via /api/auth/login 200: yes/no; dashboard opened: yes/no
ST1b: first 429 at attempt __ (exp 6); 429 body error = "Too many sign-in attempts. Please wait and try again.": yes/no
      page text = "... Please wait about N minutes ..." with N=__ and Retry-After=__ (N = ceil(Retry-After/60)): yes/no; Cache-Control no-store: yes/no
ST8: method A / B / not run; header confirmed sent (A): yes/no; first 429 at attempt __ (exp 11); statuses=__
Stop conditions hit: none / ____
Unexpected observations: ____
```

When the sheet is filled in, paste it back. Claude Code will record it in the gate document (dossier R5/R6) as
founder-reported evidence. It will mark no item passed without its numbers, and will not mark R1 or R10 complete
from this run.

## 7. Revision history

- **Revision 1** (`c6a8a97`): initial runbook.
- **Revision 2:** the review of `c6a8a97` (PR #45 review, 2026-10-24T09:31Z) raised four findings.
  1. **ST8 and `X-Forwarded-For`.** The review called it a forbidden browser request header. It is not:
     neither the WHATWG Fetch standard's forbidden request-header list nor MDN's includes it; only `Proxy-`/`Sec-`
     prefixes and a fixed set such as `Host`, `Origin`, `Via` are forbidden.
     - The underlying concern is valid, so ST8 now:
       - requires confirming in DevTools that the header was actually sent (otherwise "not exercised");
       - states that it tests the end-to-end effect only, not which layer discards the value;
       - adds a non-browser Method B, which needs no secrets and is used only when the Preview is unprotected;
       - leaves topology verification to section 5 and R10.
  2. **Single-instance limits.** ST3, ST1b and ST8 now say what a pass proves and does not prove, and section 5
     records the deployment topology.
  3. **Paid-call cap.** Section 1 now caps paid Web Risk requests at 7. Every retry, re-run or unexpected
     link-bearing test needs a new recorded approval and quota check. The ledger is checked against the running
     total after ST2 and ST6.
  4. **Exact reservation linkage.** ST2 uses an exact per-admission check (P5: `admission_id` join) instead of
     the time-window correlation, plus integrity counts. The doc states that the scan ↔ admission match remains
     by order, because the schema has no link.
- **Revision 3:** the review of `7e50f7e` (PR #45 review, 2026-10-24T10:09Z) asked for two docs-only
  changes before execution.
  1. **ST1b expected text.** The 429 **response body** is "Too many sign-in attempts. Please wait and try
     again." (`lib/security/loginFlow.ts`), as the review stated, and ST1b now checks it in the Network tab.
     The **login page** does not display that body: on a 429 it builds "… Please wait about N minutes and try
     again." from `Retry-After`. ST1b names both texts and where each appears, so the founder is not misled by
     either.
  2. **P3 staging binding.** `last_sign_in_at` is now corroboration only (P3c). P3 requires two
     project-specific proofs that expose no credential:
     - P3a: the session cookie **name** `sb-zgxmvpbvvakpsnzcymsf-auth-token`, which `@supabase/ssr` derives from
       the server's configured project URL;
     - P3b: a random-marker scan with no link (no paid request) whose `scan_id` must appear in staging
       `public.scans` for U1.

     P3d, the Preview's public `NEXT_PUBLIC_SUPABASE_URL` host in Vercel, is optional.
  - **Consistency fixes:**
    - ST8 Method B no longer hard-codes one Preview URL; it takes the recorded Preview and refuses any other
      host.
    - The evidence sheet has fields for P3a–P3d and both ST1b texts.
    - The stop condition for P3 names P3a/P3b.
    - A 60 s wait follows P3b, so it cannot affect ST2's burst window.
