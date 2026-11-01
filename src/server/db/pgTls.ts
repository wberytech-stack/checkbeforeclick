/**
 * Gate 007A / Azure migration: fail-closed PostgreSQL TLS connection options.
 * This module is pure so its security boundary can be exercised without a DB.
 * Do not log the returned connection string: it may contain credentials.
 */
export function getPgConnectionOptions(
  databaseUrl: string | undefined,
  sslSetting: string | undefined,
): { connectionString: string; ssl: false | { rejectUnauthorized: true } } {
  if (!databaseUrl) {
    throw new Error("CBC_DATABASE_URL is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("CBC_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !parsed.hostname ||
    parsed.hash
  ) {
    throw new Error("CBC_DATABASE_URL must be a PostgreSQL TCP URL without a fragment");
  }

  // Only a local disposable PostgreSQL instance may disable TLS.
  const host = parsed.hostname.toLowerCase();
  const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  if (sslSetting === "false" && !isLoopback) {
    throw new Error("CBC_DATABASE_SSL=false is permitted only for loopback PostgreSQL");
  }

  // node-postgres parses sslmode/sslcert query parameters from connectionString
  // and can override the explicit Pool.ssl configuration. Only accept modes
  // that require TLS, then remove them so the verified TLS setting wins.
  // Other query options could override host/credentials; fail closed.
  for (const [key, value] of parsed.searchParams) {
    if (key !== "sslmode" ||
        (value !== "require" && value !== "verify-full")) {
      throw new Error("CBC_DATABASE_URL contains an unsupported connection option");
    }
  }
  parsed.searchParams.delete("sslmode");

  return {
    connectionString: parsed.toString(),
    ssl: sslSetting === "false" ? false : { rejectUnauthorized: true },
  };
}
