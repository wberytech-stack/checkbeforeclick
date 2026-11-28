# Public homepage release — 2026-11-28

Base: master c8c4d6ba95c15003b054cc6980cdb8e0694fa38c. The founder requested ownership through publication of the public homepage in this chat.

The public root previously redirected every visitor to login or dashboard. It now presents the jade-lens editorial homepage with ivory/mineral-green styling, a clear Check a link action and optional Why a lens explanation. Existing /login, /scan/new and /history routes remain destinations. The example investigation is prominently illustrative, not a live scan. No Azure draft authentication/data-plane code is included; PRs58/59 remain untouched.

Only the exact public root skips the authentication middleware round trip. All private route checks, session refresh and signed-in login redirects remain unchanged. Root fonts use reviewed bundled local Geist files with the same families, weights and CSS variables; legal font text is included under app/fonts and public/fonts. Package manifests, lockfile, deployment workflow, runtime configuration, data access and provider calls are unchanged.

Validation: actual production Next16.2.6 webpack build PASS with TypeScript and13/13static pages. Independent page/layout/proxy lint PASS, no findings. Actual mocked boundary checks cover publicroot (signed in/out), six private routes, prefix boundary, and signed-in login/register redirects. Independent source review and font/image hashes PASS. Actual production browser at1265px desktop,800px tablet and320px mobile: no horizontal overflow; jade image loads; native lens/signals details work by keyboard; primary CTA52px; no captured console errors. No live sign-in or scan was performed.

The existing production workflow is manual, requires a full master-reachable SHA and uses the protected azure-production environment. The required reviewer is the founder's GitHub account. Publication is not proved by this source receipt: a successful workflow and public-domain check are required separately.

Rollback: deploy the previously released approved master SHA through the same production workflow, preserving runtime settings. No schema/dependency migration is involved.
