# Gate 007A - R1 verification checklist: Google Web Risk key, quota and billing (read-only)

**Founder-executed, read-only.**
- Claude Code wrote this checklist and made **no** Google Cloud, Vercel or Azure call.
- Every step only **looks** at a setting: no step changes a setting, calls the Web Risk API, or reveals the key.
- Where a change looks advisable, it is listed in section 8 as a **separate founder decision**, outside this
  checklist.
- **R1 stays open until the evidence sheet (section 7) is filled in and recorded in the gate doc.**

## 0. What the repository says (starting facts; verify, do not assume)

| Fact | Source |
| --- | --- |
| One environment variable, `GOOGLE_WEB_RISK_API_KEY`, holding the **production** key, **shared by Production and Preview**. Documented as a cost and quota risk, not a tenant risk | `docs/ENVIRONMENTS.md` §11 and its variable table |
| Only server code reads it (`lib/scan/providers/googleWebRisk.ts`). It is sent in the `X-Goog-Api-Key` header, never in a URL, never in browser code | repo (Gate 007A) |
| A copy may also exist in Azure Key Vault as secret `google-web-risk-api-key` (Gate 006C, founder-reported) | `infra/azure/hosting/modules/web-app.bicep`, Gate 006C doc |
| Ceiling the **current code** can make: about 500 Web Risk requests per day per Supabase project (one reservation per admission, 500 admissions per day). Staging and production together: about 1,000 per day | gate doc, "Effective Web Risk ceiling" |
| **Not capped by code:** older Preview deployments built before Gate 007A, current production (`master`), and any other holder of the key | gate doc, "Google Web Risk: every execution path" |
| Planned staging test spend: **at most 7** paid requests (runbook section 1) | `docs/gates/gate-007a-staging-runbook.md` |

**Consequence for R1.** Because the key is shared, quota and budget controls in Google Cloud are the **only**
protections that also cover older deployments and production. That is why R1 must be verified before any paid
staging request.

## 1. Rules while checking

- **Never click "Show key"** and never copy, paste, screenshot or type an API key value.
  - Before taking a screenshot, check that no key string is visible.
  - In Vercel, do not reveal or copy the variable's value.
- **Record identifiers, not secrets.** These are fine to record: the project ID, the key's **display name**, the
  key's **ID or UID** (the identifier in the console URL, not the key string), the budget name, quota names and
  values, and the last 4 characters of the billing account ID.
- **Change nothing.** Do not edit quotas, budgets, alerts, keys or variables during this checklist. A change is
  a separate, recorded founder decision (section 8).
- **Menu names may differ.** The Google Cloud console's menu names below may differ slightly in your console.
  Record what you actually see.

## 2. Which Google Cloud project owns the key

1. **Google Cloud console → APIs & Services → Credentials.** Switch through each project you own with the project
   picker at the top until you find the API key that serves CheckBeforeClick.
2. **Record:**
   - the **project ID** and **project number**;
   - the key's **display name**;
   - the key's **creation date**;
   - the key's **ID**: open the key; the ID is in the page URL. **Do not click "Show key".**
3. **How many keys:** record how many API keys that project has, and their display names.
   - If more than one could be the CheckBeforeClick key, step 6 decides which one is actually used.
4. **APIs & Services → Enabled APIs & services:** confirm **Web Risk API** is enabled in this project. Record
   yes or no.

**Expected:** exactly one project, known to you, owns the key, and Web Risk API is enabled there.

## 3. The key's restrictions

On the key's page (APIs & Services → Credentials → the key), without revealing it:

| Setting | Expected (safe) value | Record |
| --- | --- | --- |
| **API restrictions** | "Restrict key" to **Web Risk API only** | The exact list shown |
| **Application restrictions** | "None" is expected and acceptable here: the key is used only server-side from Vercel (and possibly Azure), whose outbound addresses are not fixed, so IP restriction is impractical | The value shown |
| Anything else (for example, a key rotation reminder) | n/a | As shown |

**Finding if not as expected:** if the key is **unrestricted** (usable for any API), it is a release finding.
Restricting it is a separate founder decision (section 8).

## 4. Web Risk quotas (the hard limit)

1. **Where to look:**
   - **IAM & Admin → Quotas & System Limits**, with the project selected; filter **Service: Web Risk API**.
   - Or **APIs & Services → Web Risk API → Quotas & System Limits**.
2. **Record every Web Risk quota row:** the exact quota name, the unit (per minute or per day), the **current
   value**, whether it is the default or an override you set, and the current usage shown.
3. **Specifically:** is there a **per-day** quota for the Lookup/search request type (the `uris.search` call the
   app makes)? Record its name and value, or "no per-day quota offered".

**Safe limits.** These are targets for judging what you see; changing them is section 8.
- **Per-day quota** (if offered): at most **1,000 requests per day**. That is the combined code ceiling of
  staging and production; anything far above it leaves older deployments and other holders of the key
  uncapped.
- **Per-minute quotas only:** record them. A per-minute quota alone cannot cap daily spend (for example,
  60 per minute still allows 86,400 per day). In that case the budget alert (section 5) is the main daily
  control, and that is a finding to note.
- **Current usage:** if it is well above what CheckBeforeClick should produce (a few hundred per day at most),
  that suggests another holder of the key or an older deployment calling it. **Record it as a finding.**

## 5. Billing account and budget (alerts; not a hard stop)

1. **Billing → Account management**, with the project selected. Record:
   - the **billing account name**;
   - the last 4 characters of its ID;
   - that the project is linked to it.
2. **Pricing.** Check the current Web Risk pricing on Google's official pricing page, and record the free
   allowance and per-request price you see, with the date.
   - This checklist does not quote prices, because they change.
   - From them, compute the cost of the 7 staging requests and of a worst-case day at your quota.
3. **Billing → Budgets & alerts.** Record every budget that covers this project:
   - **Name.**
   - **Scope:** does it include this project? All services, or Web Risk API only?
   - **Amount and period:** the monthly amount.
   - **Threshold rules:** each percentage, and whether it is on **actual** or **forecasted** spend.
   - **Notifications:** who receives them (billing admins, email recipients, a Pub/Sub topic). Record the role
     or address type, not private addresses, if the sheet will be shared.
   - **Last alert:** whether any alert has fired recently.

**Expected (safe).**
- At least one budget scoped to this project, with an amount you consider an acceptable worst case for a month.
- Thresholds at least at **50%, 90% and 100% actual**, plus **100% forecasted**.
- Notifications that reach **you** promptly.

**Important.** A Google Cloud budget **sends alerts but does not stop spending** by itself. Only quotas (section
4), restricting the key, or disabling it stop requests. Record whether any automated budget action exists (for
example, a Pub/Sub-triggered function); "none" is normal.

## 6. Which key the Preview actually uses, without revealing it

The goal is to tie the running Preview to the key from section 2 using only names, scopes and usage counts.

### 6a. Vercel configuration (before any test)

Vercel → the project → **Settings → Environment Variables**, search `GOOGLE_WEB_RISK_API_KEY`. **Do not reveal
the value.** Record:
- how many entries exist for this name;
- each entry's **environments** (Production, Preview, Development) and any **branch-specific** Preview scope;
- whether it is marked **Sensitive**;
- its **last updated** date.

**Expected, per the repo:** one entry scoped to Production **and** Preview, meaning the same key in both.

If you have since split it, there are two entries: one Production-only, one Preview-only. Record which Google
Cloud key (display name) you created each from; your own records of when you created them are evidence enough.

### 6b. Usage evidence (during the staging run, no extra requests)

Google Cloud console → **APIs & Services → Metrics** (or the **Web Risk API** page's Metrics tab):
- select **API: Web Risk API**;
- group or filter **by credential** (the "Credentials" filter lists API keys by display name);
- choose a time range that covers the test.

1. **Before ST2:** note the request count for each key over the last hour (normally 0, or production's own
   traffic if the key is shared).
2. **After ST2 and again after ST6:** note the counts again.

**Expected:**
- the key from section 2 rises by **4** after ST2 and by **7** in total after ST6;
- no other key rises;
- the rise equals `reservations_since` from the runbook's P5 ledger check.

If the key is shared with Production, production traffic in the same window adds to the count. Run the tests at
a quiet time, and treat "rise ≥ ledger count, with the excess explained by production `vendor_results` in the
same window" as consistent. An unexplained excess is a finding.

This step only reads metrics produced by the already-approved test requests. It makes no extra request.

### 6c. Other holders of the key (record only)

- **Azure Key Vault:** if the secret `google-web-risk-api-key` exists, record its **name** and **last updated**
  date (no value). The Gate 006C record says you wrote it.
  - Whether it holds the same key cannot be checked without revealing it. Record "same key per my records" or
    "unknown".
- **Older Vercel Preview deployments** keep the variable value they were deployed with. Changing the variable
  in Vercel does **not** remove the key from them. Only **rotating or deleting the key in Google Cloud**, or
  deleting those deployments, does. Record how many older Preview deployments are still reachable, if the
  Vercel Deployments list shows it.

## 7. Evidence sheet (copy, fill in, keep secrets out)

```text
Gate 007A R1 - Google Web Risk controls - checked by: founder        Date (UTC): ____
No "Show key", no key value copied or screenshotted: confirmed

Project:   project ID=____  number=____  Web Risk API enabled: yes/no
Key:       display name=____  key ID=____ (not the key)  created=____  keys in project=__ (names: ____)
Restrict:  API restrictions=____ (exp: Web Risk API only)  application restrictions=____ (exp: none, acceptable)
Quotas:    [name | unit | value | default/override | usage]
           ____ | ____ | ____ | ____ | ____
           ____ | ____ | ____ | ____ | ____
           per-day Lookup quota: ____ / not offered     (safe target: <= 1,000/day)
Pricing:   free allowance=____  price=____  (source page, date ____); 7 test requests cost=____; worst day at quota=____
Billing:   account name=____  ID last 4=____  project linked: yes/no
Budget:    name=____  scope=project/services ____  amount/month=____
           thresholds=____ (exp >= 50/90/100% actual + 100% forecast)  recipients reach me: yes/no
           automated budget action: none / ____   alerts fired recently: yes/no
Vercel:    GOOGLE_WEB_RISK_API_KEY entries=__  scopes=____  branch-specific=____  sensitive=yes/no  last updated=____
Azure KV:  google-web-risk-api-key exists: yes/no/not checked  last updated=____  same key per my records: yes/no/unknown
Old previews still reachable: __ / unknown
Usage before tests (last hour, per key): ____
Findings:  ____
R1 verdict (founder): controls adequate for the 7-request staging run: yes / no (reason ____)
```

During the staging run, also fill in the 6b lines and add them to the runbook's evidence sheet:
```text
Metrics by credential: before ST2=__  after ST2=__ (exp +4)  after ST6=__ (exp +7 total); other keys unchanged: yes/no
Matches ledger reservations_since: yes/no (excess explained by production traffic: ____)
```

## 8. Possible changes: separate founder decisions, NOT part of this checklist

Listed only so that findings have somewhere to go. Each needs its own explicit founder decision and is done by
the founder, not by an agent:
- Restrict the key to **Web Risk API only**, if it is not already.
- Add or lower a **per-day quota** (target ≤ 1,000/day), or lower per-minute quotas.
- Create or adjust the **budget** and **thresholds**, and add recipients.
- **Split keys:** create a separate Preview key, scope the Vercel variables separately, and update
  `docs/ENVIRONMENTS.md` §11.
- **Rotate** the shared key to cut off older Preview deployments. Consequence: every deployment and the Azure
  Key Vault secret need the new value, so it must be planned.

Until the evidence sheet is returned and recorded, **R1 remains open**. The 7 paid staging requests should not
be sent before your R1 verdict is "yes".
