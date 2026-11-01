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
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) {
    throw new EntraTokenError("IDENTITY_ENDPOINT must be the loopback managed identity endpoint")
  }
  if (clientId !== undefined && !/^[0-9a-fA-F-]{36}$/.test(clientId)) throw new EntraTokenError("AZURE_CLIENT_ID is not a GUID")

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
      const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_on?: unknown } | null
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
