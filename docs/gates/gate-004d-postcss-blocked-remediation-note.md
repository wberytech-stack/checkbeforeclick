# Gate 004D - PostCSS Blocked Remediation Note

## 1. Status

Docs-only note. No dependency remediation is performed in this gate.

## 2. Current Dependabot state

After Gate 004C and the Hono remediation PR, GitHub Dependabot shows 1
remaining open alert:

- Advisory: PostCSS has XSS via Unescaped </style> in its CSS Stringify
  Output
- Severity: Moderate
- Package: postcss
- Manifest: package-lock.json

## 3. Investigation summary

The project has a safe root-level PostCSS 8.5.15 installed through:

- @tailwindcss/postcss@4.3.0 -> postcss@8.5.15
- shadcn@4.8.0 -> postcss@8.5.15

The vulnerable copy is nested under Next:

- next@16.2.6 -> postcss@8.4.31

npm explain confirmed:

- postcss@8.4.31 is installed under node_modules/next/node_modules/postcss
- it is required exactly by next@16.2.6

## 4. Next version check

The latest available Next 16 patch checked was 16.2.10.

npm view next@16.2.10 dependencies.postcss returned: 8.4.31

Therefore updating Next from 16.2.6 to 16.2.10 would not remediate the
PostCSS alert.

## 5. Decision

Do not update Next only for this alert at this time.
Do not use npm overrides yet.
Do not manually edit package-lock.json.
Do not run npm audit fix.
Do not run npm update.

The alert is deferred until:

1. A future Next release lifts its pinned PostCSS dependency to 8.5.10
   or later, or
2. A separate override-evaluation gate explicitly tests forcing Next's
   nested postcss dependency and proves build and runtime safety.

## 6. Rationale

Next pins PostCSS exactly, which means this is a framework-owned nested
dependency. Blind overrides or manual lockfile edits could create untested
framework behavior. Since CBC does not directly parse and stringify
attacker-controlled CSS into HTML style tags as a core product flow, the
practical CBC exposure appears limited, while forcing a framework
dependency carries implementation risk.

## 7. Acceptance criteria

- Remaining PostCSS alert documented.
- Root cause documented as Next-owned nested postcss@8.4.31.
- Latest Next 16.2.10 checked and confirmed still pins postcss@8.4.31.
- No dependency files changed.
- No app code changed.
- Safe remediation deferred until upstream Next lifts the pin or a
  separate override-evaluation gate proves safety.

## 8. Out of scope

- No package.json changes.
- No package-lock.json changes.
- No npm install.
- No npm audit fix.
- No Next update.
- No override implementation.
- No app code changes.
- No Azure, cbc_prod, Key Vault, or deploy.
