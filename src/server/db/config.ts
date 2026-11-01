// Gate 008A - Azure PostgreSQL connection configuration (pure: no I/O, no imports).
//
// Hard rules enforced here (AGENTS.md sections 11 and 14):
//   - Any host other than loopback: verified TLS (certificate chain AND hostname), no override, no fallback.
//   - Any host other than loopback: Microsoft Entra authentication with the app's managed identity
//     (short-lived tokens). A database password never exists for the cloud runtime, so none can leak.
//   - Loopback (disposable validation databases only): password auth, TLS optional.
//   - The URL is parsed here into discrete fields and is NOT passed to pg as a connectionString:
//     node-postgres lets connection-string parameters (sslmode=no-verify, ssl=false, ...) override the
//     explicit ssl option, so every query parameter is rejected instead.
//
// Environment:
//   CBC_DATABASE_URL   postgres://<user>@<host>:<port>/<database>   (no password for cloud hosts)
//   CBC_DATABASE_AUTH  "entra" (required for cloud hosts) | "password" (loopback only)
//   CBC_DATABASE_SSL   "false" disables TLS - loopback only; ignored nowhere else (rejected)

export type DatabaseSsl = false | { rejectUnauthorized: true; servername?: string }

export type DatabaseConfig = {
  host: string
  port: number
  database: string
  user: string
  auth: "entra" | "password"
  password: string | undefined   // loopback "password" auth only
  ssl: DatabaseSsl
}

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DatabaseConfigError"
  }
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"])

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.toLowerCase())
}

const IDENT = /^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,127}$/   // role and database names (Entra principals may contain @ . -)
const HOST = /^(\[::1\]|[A-Za-z0-9.-]{1,253})$/

export function parseDatabaseConfig(env: Record<string, string | undefined>): DatabaseConfig {
  const raw = env.CBC_DATABASE_URL
  if (!raw) throw new DatabaseConfigError("CBC_DATABASE_URL is not set")

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new DatabaseConfigError("CBC_DATABASE_URL is not a valid URL")   // never echo the value: it may hold a password
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseConfigError("CBC_DATABASE_URL must use the postgres:// scheme")
  }
  if (url.search !== "" || url.hash !== "") {
    throw new DatabaseConfigError("CBC_DATABASE_URL must not carry query parameters or a fragment (TLS settings are not configurable)")
  }

  const host = url.hostname
  if (!HOST.test(host)) throw new DatabaseConfigError("CBC_DATABASE_URL host is invalid")
  const loopback = isLoopbackHost(host)

  const port = url.port === "" ? 5432 : Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new DatabaseConfigError("CBC_DATABASE_URL port is invalid")

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""))
  const user = decodeURIComponent(url.username)
  if (!IDENT.test(database)) throw new DatabaseConfigError("CBC_DATABASE_URL database name is missing or invalid")
  if (!IDENT.test(user)) throw new DatabaseConfigError("CBC_DATABASE_URL user is missing or invalid")
  if (/^(postgres|azure_pg_admin|azuresu|cbcpgadmin)$/i.test(user)) {
    throw new DatabaseConfigError("the application must not connect as an administrative role")   // AGENTS.md section 10
  }

  const auth = env.CBC_DATABASE_AUTH ?? (loopback ? "password" : "entra")
  if (auth !== "entra" && auth !== "password") throw new DatabaseConfigError("CBC_DATABASE_AUTH must be entra or password")
  const password = url.password === "" ? undefined : decodeURIComponent(url.password)

  if (!loopback) {
    if (auth !== "entra") throw new DatabaseConfigError("cloud databases require CBC_DATABASE_AUTH=entra (managed identity)")
    if (password !== undefined) throw new DatabaseConfigError("CBC_DATABASE_URL must not contain a password for a cloud database")
    if (env.CBC_DATABASE_SSL !== undefined) throw new DatabaseConfigError("CBC_DATABASE_SSL is not allowed for a cloud database; TLS is always verified")
  } else {
    if (auth === "entra") throw new DatabaseConfigError("entra authentication is for cloud databases only")
    if (password === undefined) throw new DatabaseConfigError("loopback password authentication needs a password")
  }

  if (env.CBC_DATABASE_SSL !== undefined && env.CBC_DATABASE_SSL !== "false") {
    throw new DatabaseConfigError('CBC_DATABASE_SSL accepts only "false" (loopback)')
  }
  // servername drives hostname verification (SNI); TLS forbids an IP address there.
  const isIp = /^[0-9.]+$/.test(host) || host.includes(":") || host.startsWith("[")
  const ssl: DatabaseSsl =
    loopback && env.CBC_DATABASE_SSL === "false"
      ? false
      : isIp ? { rejectUnauthorized: true } : { rejectUnauthorized: true, servername: host }

  return { host, port, database, user, auth, password, ssl }
}

// Safe description for logs: never includes a password or token.
export function describeDatabaseConfig(c: DatabaseConfig): string {
  return `${c.user}@${c.host}:${c.port}/${c.database} auth=${c.auth} tls=${c.ssl === false ? "off(loopback)" : "verified"}`
}
