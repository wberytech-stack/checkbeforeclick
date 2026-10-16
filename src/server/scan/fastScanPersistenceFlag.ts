import "server-only";

/**
 * Gate 003T - Fail-safe switch for the Gate 003P persistence helper.
 *
 * The /api/scan fast path calls recordFastScanResult (CBC_DATABASE_URL,
 * migration 004) ONLY when this returns true. Otherwise it uses the
 * pre-Gate 003Q terminal writes, and the pg pool is never created.
 *
 * Enabled only by the exact value "enabled". Unset, empty, "true", "1" or
 * any other value means disabled. Enabling it is Gate 003S approval B and
 * requires decisions D1-D4 to have landed first.
 */
export const FAST_SCAN_PERSISTENCE_HELPER_ENV = "CBC_FAST_SCAN_PERSISTENCE_HELPER";

export function isFastScanPersistenceHelperEnabled(): boolean {
  return process.env[FAST_SCAN_PERSISTENCE_HELPER_ENV] === "enabled";
}
