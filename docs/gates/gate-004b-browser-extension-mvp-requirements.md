# Gate 004B - Browser Extension MVP Requirements

## 1. Gate status

Requirements and spec only. No code is written, no package changes are
made, no database changes are made, no Azure resource is touched, no
connection to `cbc_prod` is made, no Key Vault changes are made, and no
deploy happens in this gate. This document defines the exact MVP
requirements for the CBC browser extension before any implementation
begins.

## 2. Background

Gate 004A positioned CBC as a privacy-first pre-click threat decision
platform and selected a browser extension as the first sellable product
wedge. Gate 004B translates that decision into a buildable, privacy-first
MVP spec. This is the last product and spec gate before implementation
planning begins.

## 3. MVP objective

The first extension MVP must achieve four things:

- Let a user check a suspicious link before clicking, without the user's
  browser visiting the suspicious destination.
- Return a clear decision in plain language, not a raw security feed.
- Keep the permission footprint minimal enough to pass extension store
  review and earn user trust from the first install.
- Prove trust, usefulness, and repeat usage before any enterprise
  features are considered.

The MVP does not need to be the most capable security tool. It needs to
be the most trustworthy one for a non-technical user who has one question:
is it safe to click this?

## 4. Supported MVP user actions

The following user actions are in scope for the first MVP:

- Right-click a link on any page and select "CheckBeforeClick" from the
  context menu to submit that link for scanning.
- Manually paste or type a URL into the extension popup and submit it
  for scanning.
- View the latest scan result in the extension popup.
- Open full scan history in the CBC web app from a link in the popup.

The following action is out of scope for MVP but planned for a later tier:

- Report a scan result to a team admin or IT.

## 5. Explicitly out of scope for MVP

The following are explicitly not part of the first MVP and must not be
included even partially:

- Automatic scanning of every page or link the user visits.
- Collection of full browsing history.
- Passive email inbox reading or monitoring.
- Page content scraping or DOM-wide inspection.
- Credential capture or form field monitoring.
- Automatic blocking or interception of browser navigation.
- Enterprise policy engine or admin-enforced scanning rules.
- SIEM, SOAR, M365, or Google Workspace integrations.
- Any claim of perfect or complete detection.

Keeping these out of MVP is a trust, legal, and extension store review
decision as much as an engineering one.

## 6. Browser permission model

The extension must follow a minimal-permission model and request only the
permissions it can justify to a privacy-conscious user and to browser
extension store reviewers.

Required permissions for MVP:

- contextMenus: to add the right-click scan option.
- storage: to hold minimal local state such as the latest result.
- activeTab: only if technically required to extract the URL from the
  current page context; must be evaluated before requesting.

Permissions to avoid unless proven necessary:

- tabs: broad tab access is not needed for a user-initiated scan.
- history: must not be requested; collecting browsing history contradicts
  the privacy model.
- webRequest or webNavigation: passive monitoring permissions; not needed
  for user-initiated scans.
- scripting: broad script injection; not needed for this MVP flow.
- Host permissions for all sites: must be avoided; broadest possible
  permission and will trigger store review scrutiny.

Any permission not listed above as required requires explicit justification
and a future gate decision before it can be added. The extension must not
request permissions speculatively.

## 7. Extension surfaces

The MVP extension has three surfaces:

Context menu item:
- Label: "CheckBeforeClick"
- Appears on right-click of any link.
- Submits the link href to the scan flow.

Popup UI:
- URL paste/type field for manual submission.
- Scan button.
- Latest result card showing verdict, reason, confidence, and safe next
  action for the most recent scan.
- Sign-in or account status area.
- Link to open full scan history in the CBC web app.

Result view within popup:
- Verdict: safe, suspicious, malicious, or unknown.
- One-line plain-English reason.
- Confidence level: high, medium, or low.
- Safe next action in plain language.
- Scanned URL or domain summary.
- Timestamp of scan.

Settings and help surface:
- Plain-language privacy note explaining what is sent during a scan.
- Link to full privacy policy.
- Link to CBC web dashboard and scan history.

## 8. MVP scan flow

The following is the required step sequence for every scan in the MVP:

1. User invokes scan via context menu or popup.
2. Extension extracts or accepts the URL.
3. Extension validates URL format locally before sending anything.
4. Extension sends the scan request to the CBC backend.
5. Backend performs the scan. The extension does not visit the target.
6. Extension receives a structured result from the backend.
7. Extension displays the result in the popup without navigating the
   browser to the target URL.
8. Result is stored in backend scan history for signed-in users.
9. Extension local storage holds only minimal recent-result state, not
   a growing history of all scans.

The extension must not open the target URL in any tab, iframe, or
background page at any point during or after the scan.

## 9. Backend API contract - request

Design-only. Not implemented in this gate.

Proposed MVP request payload sent from extension to CBC backend:

- url: the URL submitted for scanning. Required.
- source: fixed value "extension". Required.
- submission_type: "context_menu" or "popup". Required.
- client_timestamp: ISO 8601 timestamp from the extension. Required.
- extension_version: the installed extension version string. Required.
- page_origin: the origin of the page where the context menu was invoked.
  Optional. Sent only on context menu submissions and only if the user
  has approved sending this in the privacy model. Not sent on popup
  submissions.
- auth token or session token: included when the user is signed in.
  Optional depending on auth state.

The following must never be included in any scan request, in this or
any future version, without a separate explicit gate decision:

- Full page content or DOM.
- Do not send full browsing history.
- Cookies of any kind.
- Form field values.
- Credentials or passwords.
- Email inbox content.
- Any data the user did not explicitly submit for scanning.

## 10. Backend API contract - response

Design-only. Not implemented in this gate.

Proposed MVP response shape returned from CBC backend to extension:

- scan_id: unique identifier for this scan result.
- normalized_url: the URL as normalized by the backend.
- normalized_domain: the domain extracted from the scanned URL.
- verdict: one of safe, suspicious, malicious, or unknown.
- confidence: one of high, medium, or low.
- reason: one plain-English sentence explaining the verdict.
- safe_next_action: one plain-English sentence telling the user what
  to do now.
- evidence_summary: a short structured summary of the signals that
  produced the verdict. Must not be raw vendor JSON.
- created_at: ISO 8601 timestamp of when the scan completed.
- status: one of complete, pending, or failed.
- web_result_url: optional link to the full result in the CBC web app.

Display requirements for the extension:

- Unknown verdict must be displayed as useful caution, not as a broken
  or missing state. Unknown is a first-class verdict.
- The extension must not expose raw vendor API responses or JSON to the
  user.
- The extension must not show raw technical error details by default.
  Technical details may be available in the web app for signed-in users.

## 11. Authentication model

MVP should support signed-in users first. Backend scan history and tenant
isolation already depend on user and org context established in Gates
003D onward. Unauthenticated scans are not required for the first MVP.

If unauthenticated free-tier scans are considered in a later gate:

- They must be heavily rate-limited.
- They must not create tenant-scoped history.
- They must not bypass the tenant-boundary model built in Gate 003D.
- They require a separate gate decision before implementation.

Extension authentication requirements:

- The extension must never store long-lived secrets such as raw JWT
  tokens or API keys in extension local storage without a secure storage
  strategy reviewed in a future gate.
- Auth and session handling must be fully designed before any
  implementation begins.
- The extension must handle auth expiry gracefully and prompt re-login
  rather than failing silently or caching stale credentials.

## 12. Privacy model

The privacy model is a product requirement, not an afterthought.

- Every scan is user-initiated. The extension does not scan passively.
- The scan payload is minimal. Only what is listed in Section 9 is sent.
- The extension clearly explains what is sent before the first scan.
- The extension does not collect browsing history.
- The extension does not collect page content.
- The extension does not collect cookies, credentials, or form fields.
- CBC does not sell user data.
- Signed-in scan history must be visible to the user and deletable in
  a future feature gate.
- Privacy copy explaining what is sent must be present in the popup
  help or settings surface before the extension is published.

## 13. Verdict UX requirements

Each verdict must have a defined display behavior and plain-English next
action. The extension must never leave the user without guidance.

Safe:
- Display: green or neutral indicator.
- Message: the link appears safe based on available signals.
- Next action: you may proceed, but always use your judgment.

Suspicious:
- Display: amber or warning indicator.
- Message: this link has signals that warrant caution.
- Next action: avoid clicking. Go directly to the official site or
  contact the sender through a known channel to verify.

Malicious:
- Display: red or danger indicator.
- Message: this link has been identified as malicious.
- Next action: do not click. Close the message or report it to your
  IT team.

Unknown:
- Display: neutral or caution indicator. Must not look like an error.
- Message: CBC could not determine whether this link is safe.
- Next action: treat as potentially unsafe. Use the official site or
  a known safe alternative.

Unknown is a first-class verdict. It must be designed and copy-written
with the same care as safe, suspicious, and malicious. A user who sees
unknown must know what to do next without needing to understand why
CBC could not reach a verdict.

Every verdict must include a human-readable safe next action. The
extension must not display a verdict without a next action.

## 14. Error and pending states

The extension must handle all non-result states explicitly and must
always fail closed in its UX language.

Pending:
- The scan is still running.
- Display a clear "checking" or "scanning" state.
- Do not imply a verdict while the scan is incomplete.

Failed:
- The scan could not complete due to a backend error.
- Do not imply the link is safe.
- Tell the user CBC could not check this link.

Timeout:
- The scan did not return within the expected window.
- Display an unknown or caution state.
- Do not silently resolve to safe.

Backend unavailable:
- CBC backend cannot be reached.
- Tell the user CBC could not check this link right now.
- Recommend not clicking if they are unsure.

The extension must never display a safe verdict as a fallback for any
error or timeout condition. All error and unavailable states must default
to a caution or unknown posture.

## 15. Security requirements

The following security requirements apply to the extension itself, not
only to the backend:

- The extension must not navigate to the target URL at any point during
  or after the scan, in any tab, frame, or background context.
- The extension must not execute scripts from the target page.
- The extension must not render remote HTML received from the target.
- The extension must not log auth tokens, session tokens, or any secret
  to the console or to local storage in plaintext.
- The extension must not expose backend secrets or API keys in extension
  source code or in any user-accessible surface.
- The extension must treat the backend scan result as data only. It must
  not evaluate or execute any content returned by the backend as code.
- The backend must enforce tenant isolation. The extension cannot be
  trusted as the source of tenant identity. Tenant context must be
  established and verified server-side.
- The backend must rate-limit the extension scan endpoint. Rate limiting
  must not be left to the extension to enforce.

## 16. Data retention and history

- Scans submitted by signed-in users are saved to backend scan history.
- Extension local storage holds only the latest result or a minimal
  cache needed for popup display. It must not grow into a shadow
  browsing history.
- Local storage must be cleared or capped and must not persist
  indefinitely without a defined retention policy.
- User-facing scan history viewing and deletion is a future feature,
  not an MVP requirement.
- Team and admin visibility into individual user scan history is a Team
  tier feature and must not be included in the MVP.

## 17. MVP acceptance criteria

The following criteria must all be met before the extension MVP is
considered complete:

- User can install or load the extension in a supported browser.
- User can right-click a link and submit it for scanning via the context
  menu.
- User can paste or type a URL into the popup and submit it for scanning.
- User receives verdict, reason, confidence level, and safe next action
  for every completed scan.
- The browser does not visit the target URL at any point during the scan.
- The extension does not request broad browsing-history permissions.
- The extension does not send full page content in the scan request.
- A signed-in user can see their scan in backend or web scan history.
- Unknown, failed, timeout, and backend-unavailable states are all
  handled with a caution posture and a clear user message.
- No enterprise features are present in the MVP build.

## 18. Implementation sequencing after this gate

The following sequencing is required after Gate 004B is closed. No step
should begin before the prior step is complete and reviewed.

1. Dependency vulnerability audit gate before any new dependencies are
   added.
2. Implement and locally validate the pg transaction helper defined in
   Gate 003G. This is the backend foundation the scan endpoint depends
   on.
3. Implement the backend extension scan API endpoint, using the request
   and response shapes defined in Sections 9 and 10.
4. Implement the extension shell: manifest, permissions, and build
   setup.
5. Implement the popup and context menu scan flow.
6. Add local validation, privacy checks, and security review against
   the requirements in Sections 12 and 15.
7. Only after all of the above pass: consider Team reporting and admin
   workflow as a separate gate.

## 19. Risks and open questions

The following questions must be answered before implementation begins.
They are open as of this gate and require explicit decisions.

Browser support scope: Chrome first is the assumed starting point. Edge
support via the same Chromium-based manifest is likely low-cost. Firefox
requires a separate manifest and compatibility review. The MVP browser
target must be confirmed before the extension manifest is written.

Auth and session method: how the extension authenticates the user and
maintains session state must be fully designed before implementation.
Options include shared web session via cookie, explicit extension login
flow, or token-based auth with secure storage. Each has different
security and UX tradeoffs.

Unauthenticated free scans: whether the MVP allows scans without a
signed-in account is an open question. Allowing unauthenticated scans
introduces abuse, rate-limit, and data-retention complexity. Requiring
sign-in simplifies the backend but raises the barrier to first use.
This must be decided before the backend scan endpoint is implemented.

Rate limits and abuse controls: the specific rate limit values for the
extension scan endpoint must be defined before the endpoint is built.

Extension store privacy disclosure: the exact wording of the privacy
disclosure required by Chrome Web Store and Edge Add-ons store policy
must be drafted and reviewed before submission.

page_origin inclusion: whether the optional page_origin field in the
scan request provides enough signal value to justify the privacy
tradeoff of sending the referring page origin must be decided before
the extension sends it.

Evidence display: how much evidence detail to surface in the extension
popup versus reserving for the web app result view must be decided
before UI implementation begins.

## 20. Out of scope for this gate

- No code is written.
- No extension is implemented.
- No backend API is implemented.
- No package changes.
- No database changes.
- No Azure infrastructure changes.
- No connection to `cbc_prod`.
- No Key Vault changes.
- No deploy.
