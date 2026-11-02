// Provider-neutral Azure scan worker core. This module has no cloud or DB credentials.
// Caller supplies a connection restricted to cbc_worker and a bounded provider adapter.
// Never log input, lease tokens, evidence, provider exceptions, or SQL errors.
export type WorkerQuery = {
  query(sql: string, params: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
};
export type ScanJob = {
  scanId: string;
  inputType: "url" | "domain" | "email" | "header" | "signature" | "batch";
  rawInput: string;
  signal: AbortSignal;
};
export type ScanCompletion = {
  status: "complete" | "failed";
  verdict: "safe" | "suspicious" | "dangerous" | "unknown" | null;
  riskScore: number | null;
  confidenceScore: number | null;
  explanation: string | null;
  recommendedAction: string | null;
  durationMs: number | null;
  vendorResults: Record<string, unknown>[];
  evidenceItems: Record<string, unknown>[];
};
export type ScanProcessor = (job: ScanJob) => Promise<ScanCompletion>;
export type WorkerEvent = "completed" | "lease_lost" | "timeout" | "provider_error" | "storage_error";
export type WorkerOptions = {
  batchSize?: number;
  leaseSeconds?: number;
  maxWorkMs?: number;
  now?: () => number;
  onEvent?: (event: WorkerEvent) => void;
};
export type WorkerSummary = { claimed: number; completed: number; leaseLost: number; failed: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INPUTS = new Set(["url", "domain", "email", "header", "signature", "batch"]);
const CLAIM = "SELECT * FROM public.app_claim_scan_jobs($1, $2)";
const COMPLETE = "SELECT public.app_complete_scan_job($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb) AS ok";
const FAIL = "Azure worker storage operation failed";

export class WorkerStorageError extends Error {
  constructor() { super(FAIL); this.name = "WorkerStorageError"; }
}
class WorkTimeoutError extends Error {}
function integerIn(value: unknown, low: number, high: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= low && value <= high;
}
function validateCompletion(value: ScanCompletion): [unknown[], string, string] {
  if (!value || !["complete", "failed"].includes(value.status) ||
    (value.verdict !== null && !["safe", "suspicious", "dangerous", "unknown"].includes(value.verdict)) ||
    (value.riskScore !== null && !integerIn(value.riskScore, 0, 100)) ||
    (value.confidenceScore !== null && !integerIn(value.confidenceScore, 0, 100)) ||
    (value.durationMs !== null && !integerIn(value.durationMs, 0, 3600000)) ||
    (value.explanation !== null && (typeof value.explanation !== "string" || value.explanation.length > 20000)) ||
    (value.recommendedAction !== null && (typeof value.recommendedAction !== "string" || value.recommendedAction.length > 20000)) ||
    !Array.isArray(value.vendorResults) || !Array.isArray(value.evidenceItems) ||
    value.vendorResults.length > 100 || value.evidenceItems.length > 100 ||
    (value.status === "complete" && !value.vendorResults.length && !value.evidenceItems.length)) {
    throw new Error("Invalid provider result");
  }
  const vendors = JSON.stringify(value.vendorResults);
  const evidence = JSON.stringify(value.evidenceItems);
  if (typeof vendors !== "string" || typeof evidence !== "string" ||
    new TextEncoder().encode(vendors).length > 262144 || new TextEncoder().encode(evidence).length > 262144) {
    throw new Error("Invalid provider result");
  }
  return [[value.status, value.verdict, value.riskScore, value.confidenceScore,
    value.explanation, value.recommendedAction, value.durationMs], vendors, evidence];
}
function leaseDate(value: unknown): number {
  if (!(value instanceof Date) && typeof value !== "string") return NaN;
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
function emit(options: WorkerOptions, event: WorkerEvent): void {
  try { options.onEvent?.(event); } catch { /* Observability must never affect a lease. */ }
}

/**
 * Claims at most 10 committed leases, processes sequentially, and commits each
 * completion through the lease-token-checked database function. A failed or
 * timed-out provider call is NOT acknowledged; lease expiry enables retry.
 * This is at-least-once, not exactly-once external provider execution.
 */
export async function runAzureScanWorkerBatch(
  db: WorkerQuery, process: ScanProcessor, options: WorkerOptions = {},
): Promise<WorkerSummary> {
  const size = options.batchSize ?? 1;
  const seconds = options.leaseSeconds ?? 120;
  const maxWorkMs = options.maxWorkMs ?? 60000;
  if (!integerIn(size, 1, 10) || !integerIn(seconds, 30, 600) ||
    !integerIn(maxWorkMs, 1000, 600000) || maxWorkMs > seconds * 1000 - 5000) {
    throw new Error("Invalid worker limits");
  }
  let rows: Record<string, unknown>[];
  try {
    const result = await db.query(CLAIM, [size, seconds]);
    if (!result || !Array.isArray(result.rows) || result.rows.length > size) throw new Error("Invalid claim result");
    rows = result.rows;
  } catch {
    emit(options, "storage_error");
    throw new WorkerStorageError();
  }
  // A single batch must never process a scan twice, even if a broken adapter
  // returns duplicate claims. Validate this before invoking any provider.
  const ids = new Set<unknown>();
  for (const row of rows) {
    if (!row || typeof row.o_scan_id !== "string" || ids.has(row.o_scan_id)) {
      emit(options, "storage_error");
      throw new WorkerStorageError();
    }
    ids.add(row.o_scan_id);
  }
  const summary: WorkerSummary = { claimed: rows.length, completed: 0, leaseLost: 0, failed: 0 };
  for (const row of rows) {
    const { o_scan_id: scanId, o_lease_token: token, o_input_type: inputType,
      o_raw_input: rawInput, o_attempt_count: attemptCount, o_leased_until: until } = row;
    const deadline = leaseDate(until);
    if (typeof scanId !== "string" || !UUID.test(scanId) ||
      typeof token !== "string" || !UUID.test(token) ||
      typeof inputType !== "string" || !INPUTS.has(inputType) ||
      typeof rawInput !== "string" || !integerIn(attemptCount, 1, 8) ||
      !Number.isFinite(deadline)) {
      emit(options, "storage_error");
      throw new WorkerStorageError();
    }
    // Five seconds of safety margin for completion SQL and clock skew.
    const remaining = deadline - (options.now?.() ?? Date.now()) - 5000;
    if (remaining < 1000) { summary.failed++; emit(options, "lease_lost"); continue; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let completion: ScanCompletion;
    try {
      completion = await Promise.race([
        process({ scanId, inputType: inputType as ScanJob["inputType"], rawInput, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { controller.abort(); reject(new WorkTimeoutError()); }, Math.min(remaining, maxWorkMs));
        }),
      ]);
      const [fields, vendors, evidence] = validateCompletion(completion);
      if (deadline - (options.now?.() ?? Date.now()) < 5000) {
        summary.failed++; emit(options, "lease_lost"); continue;
      }
      try {
        const result = await db.query(COMPLETE, [scanId, token, ...fields, vendors, evidence]);
        if (!result || !Array.isArray(result.rows) || result.rows.length !== 1 ||
          typeof result.rows[0]?.ok !== "boolean") throw new Error("Invalid completion result");
        if (result.rows[0].ok) { summary.completed++; emit(options, "completed"); }
        else { summary.leaseLost++; emit(options, "lease_lost"); }
      } catch {
        summary.failed++; emit(options, "storage_error");
      }
    } catch (error) {
      summary.failed++;
      emit(options, error instanceof WorkTimeoutError ? "timeout" : "provider_error");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controller.abort();
    }
  }
  return summary;
}
