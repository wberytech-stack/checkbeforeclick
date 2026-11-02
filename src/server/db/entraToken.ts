// Gate 008A - Microsoft Entra access tokens for Azure Database for PostgreSQL, from the Container App's
// managed identity. Pure module: the fetch, clock and environment are injected (tested offline in
// scripts/azure-data/test-db-config.ts). No dependency.
//
// Protocol (Azure Container Apps managed identity endpoint):
//   GET  $IDENTITY_ENDPOINT?resource=https://ossrdbms-aad.database.windows.net&api-version=2019-08-01&client_id=<uami>
//   header X-IDENTITY-HEADER: $IDENTITY_HEADER
//   -> { access_token, expires_on (epoch seconds) }
// The token is the PostgreSQL password; it lives about an hour and is cached until 5 minutes before expiry.
//
// Safety:
//   - IDENTITY_HEADER is sent only to a loopback http endpoint (the platform sidecar). Anything else is refused,
//     so a tampered IDENTITY_ENDPOINT cannot exfiltrate the header or receive a token request.
//   - Tokens and the identity header never appear in errors or logs.

export const POSTGRES_ENTRA_RESOURCE = "https://ossrdbms-aad.database.windows.net"
const REFRESH_MARGIN_MS = 5 * 60 * 1000
const MAX_TOKEN_CHARS = 16384

export class EntraTokenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "EntraTokenError"
  }
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; redirect: "error"; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

export function createManagedIdentityTokenProvider(deps: {
  env: Record<string, string | undefined>
  fetch: FetchLike
  now: () => number
  timeoutMs?: number
}): () => Promise<string> {
  const endpoint = deps.env.IDENTITY_ENDPOINT
  const header = deps.env.IDENTITY_HEADER
  const clientId = deps.env.AZURE_CLIENT_ID
  if (!endpoint || !header) throw new EntraTokenError("managed identity is not available (IDENTITY_ENDPOINT/IDENTITY_HEADER unset)")
  let base: URL
  try {
    base = new URL(endpoint)
  } catch {
    throw new EntraTokenError("IDENTITY_ENDPOINT is not a valid URL")
  }
  // The rotating platform header is a credential: never send it to an
  // endpoint with embedded credentials, pre-existing query parameters or a
  // fragment. The platform supplies the endpoint, not the application.
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) ||
      base.username || base.password || base.search || base.hash) {
    throw new EntraTokenError("IDENTITY_ENDPOINT must be a clean loopback managed identity endpoint")
  }
  // CBC always uses a dedicated user-assigned identity. Omitting client_id
  // would silently select a system-assigned identity, potentially with
  // different database privileges. Never permit that fallback.
  if (!clientId || !/^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/.test(clientId)) {
    throw new EntraTokenError("AZURE_CLIENT_ID must identify a user-assigned managed identity")
  }
  if (/[\x00-\x1f\x7f]/.test(header) || header.length > 2048) {
    throw new EntraTokenError("IDENTITY_HEADER is invalid")
  }

  let cached: { token: string; expiresAt: number } | null = null
  let inflight: Promise<string> | null = null

  async function fetchToken(): Promise<string> {
    const url = new URL(base.href)
    url.searchParams.set("resource", POSTGRES_ENTRA_RESOURCE)
    url.searchParams.set("api-version", "2019-08-01")
    if (clientId) url.searchParams.set("client_id", clientId)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 5000)
    try {
      let res: Awaited<ReturnType<FetchLike>>
      try {
        res = await deps.fetch(url.href, {
          method: "GET",
          headers: { "X-IDENTITY-HEADER": header as string },
          redirect: "error",
          signal: controller.signal,
        })
      } catch {
        throw new EntraTokenError("managed identity endpoint unreachable")
      }
      if (!res.ok) throw new EntraTokenError(`managed identity endpoint returned ${res.status}`)
      const body = (await res.json().catch(() => null)) as {
        access_token?: unknown; expires_on?: unknown
        client_id?: unknown; resource?: unknown; token_type?: unknown
      } | null
      // Azure's endpoint may return identity, audience and token-type metadata.
      // If present, each MUST agree with the request. Never cache a credential
      // for a different principal or audience, even if the sidecar misbehaves.
      if (body?.client_id !== undefined &&
          (typeof body.client_id !== "string" || body.client_id.toLowerCase() !== clientId.toLowerCase())) {
        throw new EntraTokenError("managed identity endpoint returned the wrong client identity")
      }
      if (body?.resource !== undefined && body.resource !== POSTGRES_ENTRA_RESOURCE) {
        throw new EntraTokenError("managed identity endpoint returned the wrong resource")
      }
      if (body?.token_type !== undefined &&
          (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer")) {
        throw new EntraTokenError("managed identity endpoint returned an invalid token type")
      }
      const token = body?.access_token
      const expiresOn = Number(body?.expires_on)
      if (typeof token !== "string" || token.length < 20 || token.length > MAX_TOKEN_CHARS || /\s/.test(token)) {
        throw new EntraTokenError("managed identity endpoint returned no usable token")
      }
      if (!Number.isFinite(expiresOn) || expiresOn * 1000 <= deps.now() + REFRESH_MARGIN_MS) {
        throw new EntraTokenError("managed identity token has no usable expiry")
      }
      cached = { token, expiresAt: expiresOn * 1000 }
      return token
    } finally {
      clearTimeout(timer)
    }
  }

  return async function getToken(): Promise<string> {
    if (cached && cached.expiresAt - REFRESH_MARGIN_MS > deps.now()) return cached.token
    // One request at a time: concurrent pool connections share it.
    inflight ??= fetchToken().finally(() => { inflight = null })
    return inflight
  }
}
