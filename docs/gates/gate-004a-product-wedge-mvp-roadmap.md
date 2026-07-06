# Gate 004A - Product Wedge and MVP Roadmap

## 1. Gate status

Product strategy only. No code is written, no package changes are made,
no Azure resource is touched, no connection to `cbc_prod` is made, no Key
Vault changes are made, and no deploy happens in this gate. This document
defines CBC's first commercial product wedge and MVP roadmap.

## 2. Background

CBC started as a suspicious URL and domain scan platform. Recent
architecture gates hardened the tenant-boundary model (Gate 003D Slice 1),
defined the runtime transaction path (Gates 003E/003F), and selected the
PostgreSQL client direction (Gate 003G). The backend infrastructure is
taking shape. The product now needs a clear first commercial wedge that
matches where the architecture is headed without waiting for the full
Azure-native migration to complete.

This document evaluates the product wedge not in isolation but against the
final CBC SaaS product vision: a platform that helps organizations make
safe, defensible, pre-click decisions across links, QR codes, SaaS consent
flows, and future email artifacts.

## 3. Product category

CBC is a pre-click threat decision platform.

It helps users and teams decide what to do before clicking links, scanning
QR codes, approving SaaS consent flows, visiting suspicious domains, and
eventually before acting on other email and message artifacts.

CBC should not be positioned as only a URL scanner. URL scanning is a
commodity. The defensible product category is pre-click decision-making:
combining signal (what the link does), context (who is being targeted and
what is the surrounding message), and explanation (a plain-English reason
the user can act on and share) into one operationally useful verdict.

## 4. First sellable wedge

The first off-the-shelf product wedge is a privacy-first browser extension
backed by the CBC decision backend.

The extension owns the exact risk moment: the user is looking at a link,
QR code, or suspicious message and wants to know whether it is safe before
clicking. That moment does not require IT approval, procurement, an API
key, or enterprise onboarding. It requires one click to install and one
right-click to scan.

The extension is the front door, not the whole product. It creates
individual users before it creates organizational buyers. It generates real
scan data from day one. It builds trust through repeated correct verdicts
before CBC asks for money or organizational access. Bottom-up adoption
through individual installs is the cheapest and most credible sales motion
available to CBC at this stage.

## 5. First MVP workflow

The first MVP workflow is deliberately minimal:

1. User sees a suspicious link, QR code, or domain in any context.
2. User right-clicks and submits to CheckBeforeClick, or manually pastes
   the link into the CBC interface.
3. CBC scans safely through the backend. The user's browser does not visit
   the suspicious destination.
4. User receives four things:
   - Verdict: safe, suspicious, unknown, or malicious.
   - One-line plain-English reason the user can read, act on, and forward
     to a colleague without translation.
   - Confidence level: high, medium, or low, so the user knows how much
     weight to put on the verdict.
   - Safe next action: what to do now, in plain language.
5. Result is saved to the user's scan history and can be shared with or
   reported to a team admin later.

This workflow requires no training, no security background, and no
existing relationship with CBC. It should work for the EA who has never
heard of a reputation score as well as for the analyst who has.

## 6. Privacy and trust principles

Privacy is part of the product moat, not an afterthought.

- CBC scans only what the user explicitly submits. It does not scan every
  page the user visits.
- CBC starts with minimal browser permissions. It does not request access
  to full browsing history.
- CBC clearly explains what is sent for scanning before the scan happens.
- CBC does not sell user data.
- Enterprise controls (policy-based scanning, admin visibility, forced
  reporting) are introduced only in the Team and Enterprise tiers, not
  forced on individual users.

The reason privacy is a moat: security tools that collect everything
eventually become a liability. A tool with minimal permissions and clear
consent is easier to approve in a corporate environment, easier to trust
as an individual user, and harder to attack as a company. The browser
extension store review process also rewards minimal permissions. Starting
with a conservative permission model and expanding carefully is easier
than starting broad and trying to reduce later.

## 7. Target users

Primary users at launch:

- Individuals who encounter suspicious links in email, messaging apps,
  or social media and are not sure whether to click.
- Finance, HR, legal, and executive assistant roles who are high-value
  phishing targets and know it.
- Small business owners and nonprofit administrators who do not have a
  dedicated security team.
- MSP technicians and help desk staff who investigate suspicious links
  on behalf of clients or colleagues.

Secondary users reached through team adoption:

- SOC and security analysts who want a fast, explainable pre-click check
  with an audit trail.
- IT administrators who want visibility into what their team is
  encountering and escalating.

Enterprise buyers are reached last, through bottom-up adoption. The
individual user becomes the internal champion. The team dashboard becomes
the proof of value. The enterprise deal follows when IT asks what tool
the team has been using.

## 8. Packaging and monetization

Four tiers, introduced in sequence as the product matures:

Free: limited manual scans per day, basic verdict and one-line reason.
Builds trust, drives word of mouth, generates scan data. No credit card
required.

Personal: unlimited scans, full scan history, deeper explanation and
evidence, confidence level detail. Small monthly or annual fee. Sells
itself to individuals who had a scare or work in a role where suspicious
links are a daily reality.

Team: everything in Personal, plus shared scan history, report-to-admin
workflow, team dashboard showing what the team is encountering, analyst
notes, and simple admin controls. Flat per-seat fee. This is the bridge
to the enterprise deal without a full enterprise sales motion.

Enterprise: everything in Team, plus SSO, policy-based controls, SIEM
and SOAR integrations, M365 and Google Workspace integrations, full API
access, audit log exports, and SLA. Sold through a standard enterprise
motion once bottom-up adoption has produced internal champions.

## 9. Product moat

The moat is not the scan. The moat is everything around it:

- Plain-English verdict that a non-technical user can act on and forward
  without translation.
- Confidence-aware result that does not cry wolf. An extension that flags
  everything trains users to ignore it. An extension that is mostly silent
  and speaks up only when it matters trains users to listen.
- Evidence and explanation that travel without the analyst. The one-line
  reason is the product the user shares with their team.
- Unknown verdict that is operationally useful. Unknown plus credential
  form plus new domain plus no reputation data is a high-risk result even
  without a confirmed malicious classification.
- Tenant and team memory. What the team has seen before, what was
  confirmed safe or malicious, what was escalated. Generic tools cannot
  know this. CBC can.
- Decision ledger and audit trail. Tamper-evident, exportable record of
  what was checked, when, by whom, and what was decided. This is the
  compliance and legal feature that sells to a completely different buyer
  than the security analyst.
- Safe next action. Not just a verdict but a recommended next step in
  plain language.
- Future moat extensions: QR code extraction and scan, OAuth and device-
  code consent risk, brand and domain mismatch detection, pretext and
  social engineering pattern detection, safe preview without visiting the
  destination.

## 10. Architecture fit

The browser extension and the backend decision engine are two separate
layers with different jobs:

- Browser extension is the adoption layer. It owns the user moment,
  requires minimal permissions, and submits only what the user explicitly
  requests. It does not make decisions itself.
- CBC backend is the decision and intelligence layer. It runs the scan,
  applies the tenant-boundary rules already built in Gates 003D onward,
  produces the verdict, evidence, and explanation, and stores the result.
- Team dashboard is the monetization and retention layer. It gives admins
  visibility, gives teams shared memory, and gives CBC a reason to charge
  per seat.
- Enterprise integrations are the expansion layer. SIEM, SOAR, M365,
  Google Workspace, API access. These are not MVP features; they are the
  reason enterprise buyers renew and expand.

Architecture requirements that must be preserved regardless of product
direction:

- Azure-native direction remains the target. No decision in this gate
  changes that.
- Tenant isolation and fail-closed behavior are non-negotiable at every
  layer.
- Least-privileged runtime role for all database access.
- Auditability: every scan result must be traceable to a user, an
  organization, a timestamp, and the evidence that produced the verdict.
- The Supabase service-role pattern remains legacy only and must not be
  deepened.

## 11. MVP boundaries

What is in scope for the first MVP:

- Manual right-click or paste-to-scan workflow.
- Verdict, one-line reason, confidence level, safe next action.
- Basic scan history for the individual user.
- Free and Personal tiers.

What is explicitly out of scope for the first MVP:

- Automatic scan of every page the user visits.
- Email inbox reading or passive monitoring.
- Heavy page content inspection at scale.
- Enterprise integrations, SSO, policy controls.
- Any claim of perfect or complete detection.
- Broad data collection beyond what the user explicitly submits.
- QR, OAuth risk, pretext detection, safe preview. These are roadmap
  features, not MVP features.

Keeping MVP scope tight is a trust and legal decision as much as an
engineering decision. A minimal-permission extension that does exactly
what it says is easier to approve, easier to review in browser extension
stores, and easier to defend if a scan result is ever disputed.

## 12. Success metrics

Activation: extension installed and first scan completed by the same user.

Engagement: scans per active user per week. A user who installs and never
scans again has not been activated in any meaningful sense.

Trust: low false-alarm complaint rate. If users are regularly getting
flagged verdicts on links they know are safe, the extension trains them
to ignore it, which is worse than no extension.

Conversion: free to Personal, Personal to Team. The conversion trigger is
almost always a scare - a user who nearly clicked something bad and wants
more coverage.

Team value: number of scan results shared with or reported to an admin.
This is the leading indicator of a Team tier sale.

Security value: suspicious or unknown links that were escalated or
avoided rather than clicked. This is the outcome metric that matters to
the actual buyer.

Retention: repeat use after the first scare. A user who installs after
one close call and never uses it again is not retained. A user who checks
links as a habit is the product working as intended.

## 13. Risks and mitigations

Privacy concern: users and organizations may be uncomfortable with a
browser extension that sends URLs to a third-party backend. Mitigate with
minimal permissions, explicit user-initiated scanning only, clear
disclosure of what is sent, and a published privacy policy before launch.

False positives: a verdict of suspicious or malicious on a link the user
knows is safe destroys trust faster than any other failure mode. Mitigate
with confidence-aware verdicts, plain-English explanations that give the
user enough context to make their own judgment, and a simple feedback
mechanism so users can flag incorrect verdicts.

False negatives: a safe verdict on a malicious link is the worst security
outcome. Mitigate with fail-closed handling for unknown links that have
high-risk signals, and a clear unknown verdict that tells the user what
CBC does not know rather than pretending confidence that does not exist.

Extension store review: Chrome and Edge extension stores review
permissions carefully. Minimal permissions and a clear, narrow stated
purpose reduce review risk and approval time.

Enterprise skepticism: security and IT buyers will ask about data handling,
tenant isolation, and audit trail before approving an extension for
organizational use. Mitigate with the audit trail and tenant isolation
already built into the backend, and admin controls in the Team tier before
approaching enterprise buyers.

Data quality: scan verdicts are only as good as the signals behind them.
Mitigate with structured evidence attached to every verdict, a feedback
loop that lets analysts mark verdicts as correct or incorrect, and analyst
override capability in the Team and Enterprise tiers.

## 14. Roadmap phases

Phase 1: Extension plus backend scan plus simple web-based scan history.
Manual right-click or paste-to-scan. Verdict, one-line reason, confidence,
safe next action. Free tier only. Goal: trust and data.

Phase 2: Personal paid plan. Unlimited scans, full history, deeper
evidence display. Goal: first revenue and conversion learning.

Phase 3: Team dashboard and report-to-IT workflow. Shared scan history,
admin visibility, analyst notes, team alerts. Goal: per-seat revenue and
bottom-up enterprise pipeline.

Phase 4: Evidence graph, decision ledger, analyst override, feedback loop.
Structured evidence attached to every verdict. Exportable audit trail.
Goal: enterprise readiness and compliance buyers.

Phase 5: QR and screenshot scan, brand impersonation detection, pretext
and social engineering pattern detection, safe preview without visiting
the destination. Goal: product moat extension and press-worthy
differentiation.

Phase 6: Enterprise integrations. API, SIEM, SOAR, M365, Google
Workspace, SSO, policy controls, SLA. Goal: enterprise expansion revenue
and retention.

## 15. Out of scope for this gate

- No code is written.
- No extension is implemented.
- No UI changes.
- No database changes.
- No dependency changes.
- No Azure infrastructure changes.
- No connection to `cbc_prod`.
- No Key Vault changes.
- No deploy.
