/**
 * Azure-only scan creation. Browser input never selects a tenant, user or role.
 * The session is resolved and the SECURITY DEFINER app_create_scan() call runs
 * on one transaction-local RLS connection. No queue work is dispatched here.
 */
import "server-only";
import {
  withAzureTenantSession,
  type AzureTenantSessionDependencies,
} from "../auth/azureTenantSession";
import { parseAzureRuntimeConfig, type AzureRuntimeEnvironment } from "../auth/azureRuntimeConfig";

export type AzureScanCreateDependencies = AzureTenantSessionDependencies & {
  env: AzureRuntimeEnvironment;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPES = new Set(["url", "domain", "email", "header", "signature", "batch"]);
const MAX_BODY_BYTES = 12000;
const HEADERS = {
  "cache-control": "private, no-store, max-age=0",
  "vary": "Cookie, Origin, Sec-Fetch-Site",
  "x-content-type-options": "nosniff",
};
const CREATE_SQL = "SELECT public.app_create_scan($1::text, $2::text) AS id";

// Exactly two string-valued members, no duplicate or unknown keys. This
// deliberately narrow JSON grammar prevents ambiguous duplicate-key parsing.
const JSON_STRING = String.raw`"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"`;
const BODY = new RegExp(`^\\s*\\{\\s*(${JSON_STRING})\\s*:\\s*(${JSON_STRING})\\s*,\\s*(${JSON_STRING})\\s*:\\s*(${JSON_STRING})\\s*\\}\\s*$`);

class BodyTooLarge extends Error {}

function respond(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, { status, headers: HEADERS });
}

function parseInput(text: string): { inputType: string; rawInput: string } | null {
  const match = BODY.exec(text);
  if (!match) return null;
  try {
    const firstKey: unknown = JSON.parse(match[1]);
    const firstValue: unknown = JSON.parse(match[2]);
    const secondKey: unknown = JSON.parse(match[3]);
    const secondValue: unknown = JSON.parse(match[4]);
    if (firstKey === secondKey ||
        !["input_type", "raw_input"].includes(String(firstKey)) ||
        !["input_type", "raw_input"].includes(String(secondKey))) return null;
    const values = new Map([[firstKey, firstValue], [secondKey, secondValue]]);
    const inputType = values.get("input_type");
    const rawInput = values.get("raw_input");
    if (typeof inputType !== "string" || !TYPES.has(inputType) ||
        typeof rawInput !== "string" || rawInput.trim().length === 0 ||
        rawInput.length > 10000 || rawInput.includes("\0")) return null;
    return { inputType, rawInput };
  } catch { return null; }
}

async function boundedBody(request: Request): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* size rejection takes precedence */ }
        throw new BodyTooLarge();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}

/** No response is emitted until the tenant-scoped database transaction commits. */
export async function runAzureScanCreateRoute(
  request: Request,
  deps: AzureScanCreateDependencies,
): Promise<Response> {
  let origin: string;
  try { origin = parseAzureRuntimeConfig(deps.env).publicOrigin; }
  catch { return respond(503, { error: "Scan temporarily unavailable" }); }

  try {
    const url = new URL(request.url);
    if (request.method !== "POST") return respond(405, { error: "Method not allowed" });
    if (url.origin !== origin || url.pathname !== "/api/azure/scans" || url.search || url.hash ||
        request.headers.get("origin") !== origin ||
        ![null, "same-origin"].includes(request.headers.get("sec-fetch-site"))) {
      return respond(403, { error: "Forbidden" });
    }
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "") ||
        request.headers.has("content-encoding")) {
      return respond(415, { error: "Unsupported media type" });
    }
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || !Number.isSafeInteger(Number(declared)))) {
      return respond(400, { error: "Invalid request" });
    }
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
      return respond(413, { error: "Request too large" });
    }
    let body: string;
    try { body = await boundedBody(request); }
    catch (error) {
      return error instanceof BodyTooLarge
        ? respond(413, { error: "Request too large" })
        : respond(400, { error: "Invalid request" });
    }
    const input = parseInput(body);
    if (!input) return respond(400, { error: "Invalid scan input" });

    const result = await withAzureTenantSession(request.headers.get("cookie"), deps,
      async (client, session) => {
        // The database rechecks current membership/role inside app_create_scan;
        // this check only makes the ordinary viewer denial explicit to callers.
        if (session.role === "viewer") return { kind: "forbidden" as const };
        const created = await client.query(CREATE_SQL, [input.inputType, input.rawInput]);
        if (created.rows.length !== 1 || typeof created.rows[0]?.id !== "string" ||
            !UUID.test(created.rows[0].id)) throw new Error("Invalid scan creation result");
        return { kind: "created" as const, id: created.rows[0].id };
      });
    if (!result.authenticated) return respond(401, { error: "Unauthorized" });
    if (result.value.kind === "forbidden") return respond(403, { error: "Forbidden" });
    return respond(201, { id: result.value.id, status: "pending" });
  } catch {
    // SQL/commit details, credentials and scan input never reach the browser.
    return respond(503, { error: "Scan temporarily unavailable" });
  }
}
