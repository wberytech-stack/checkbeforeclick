# Clean Azure web image (draft; no deployment)

`Dockerfile.azure-web` builds the existing Next.js application as a standalone
container without Supabase or Inngest build arguments. This is a **transitional
web image**, not proof that every legacy dependency has been removed from the
bundle. The new scan UI is `/azure`; the root path redirects there.

The image sets `CBC_AZURE_ONLY_MODE=1` in both build and runtime stages.
`proxy.ts` enforces a narrow allowlist **before** any legacy Supabase client
is instantiated. The allowlist contains the Azure UI, Entra login/start/logout
and callback routes, tenant-scoped Azure scan create/read routes, and the
unauthenticated liveness probe. Every other dynamic legacy route is denied
with a non-cacheable 404. The legacy routes still exist in source and must
not be accidentally re-enabled on the Azure deployment.

The Azure endpoints **must** continue authenticating and authorizing at their
own HTTP/database boundaries; bypassing legacy Supabase proxy auth is not
an authorization bypass. The callback must validate issuer, state, nonce,
PKCE, and session commit. The scan APIs must enforce origin, role, tenant
membership, PostgreSQL RLS and database permissions. Static files are
excluded from the Next.js proxy matcher.

Build locally, without cloud credentials:

```sh
docker build -f Dockerfile.azure-web -t cbc-azure-web:local .
node --experimental-strip-types scripts/azure-auth/test-azure-web-routing.ts
```

The Azure OIDC PR workflow also builds the image and runs the routing test.
A successful image build proves **only** image compilation, not login,
database, scan processing or deployment. A real end-to-end smoke test still
requires separately approved Azure provisioning and secrets.

## Deployment contract (approval required)

- Run the web image in Azure Container Apps with `CBC_AZURE_ONLY_MODE=1`.
- Configure `CBC_AZURE_PUBLIC_ORIGIN`, Entra issuer/client ID, and OIDC
  state keys at runtime from approved secure configuration.
- Use a dedicated **web** managed identity and restricted `cbc_app`
  PostgreSQL role with verified TLS. Never grant owner/BYPASSRLS.
- Deploy the separate `Dockerfile.azure-worker` image with its own
  managed identity and restricted `cbc_worker` role.
- Schedule the worker separately; a web HTTP request must never synchronously
  execute the paid reputation provider.
- Do not deploy without reviewing migrations, callback URLs, role grants,
  job schedule, cost controls, smoke tests and rollback.

This document authorizes no provisioning, deployment, secret creation,
database writes, provider billing or manual workflow dispatch.
