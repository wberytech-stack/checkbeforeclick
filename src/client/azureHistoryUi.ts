/** Strict browser parsing of tenant-filtered recent Azure scan history. */
export type AzureHistoryItem = {
  id: string;
  raw_input: string;
  status: "pending" | "processing" | "complete" | "failed";
  verdict: string | null;
  created_at: string;
};
export type AzureHistoryView = { scans: AzureHistoryItem[]; has_more: boolean };
export type AzureHistoryFilter = "all" | "attention" | "dangerous" | "suspicious" | "active" | "complete";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UTC_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function parseAzureScanHistory(value: unknown): AzureHistoryView {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid history");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.scans) || body.scans.length > 50 || typeof body.has_more !== "boolean") {
    throw new Error("Invalid history");
  }
  const seen = new Set<string>();
  const scans = body.scans.map((entry: unknown): AzureHistoryItem => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid history item");
    const row = entry as Record<string, unknown>;
    if (typeof row.id !== "string" || !UUID.test(row.id) || seen.has(row.id) ||
        typeof row.raw_input !== "string" || row.raw_input.length > 10000 ||
        (typeof row.status !== "string" || !["pending", "processing", "complete", "failed"].includes(row.status)) ||
        !(row.verdict === null || (typeof row.verdict === "string" && row.verdict.length <= 64)) ||
        typeof row.created_at !== "string" || !UTC_DATE.test(row.created_at) ||
        (!Number.isFinite(Date.parse(row.created_at)) || new Date(row.created_at).toISOString() !== row.created_at)) throw new Error("Invalid history item");
    seen.add(row.id);
    return {
      id: row.id, raw_input: row.raw_input,
      status: row.status as AzureHistoryItem["status"],
      verdict: row.verdict as string | null,
      created_at: row.created_at,
    };
  });
  return { scans, has_more: body.has_more };
}

export function historyRiskLabel(item: AzureHistoryItem): string {
  if (item.status === "failed") return "Unavailable";
  if (item.status === "pending" || item.status === "processing") return "In progress";
  if (item.verdict === "dangerous") return "Dangerous";
  if (item.verdict === "suspicious") return "Suspicious";
  return "Unconfirmed";
}

export function filterAzureHistory(
  items: readonly AzureHistoryItem[],
  query: string,
  filter: AzureHistoryFilter,
): AzureHistoryItem[] {
  const term = query.trim().toLocaleLowerCase("en");
  return items.filter((item) => {
    const matches = !term || item.raw_input.toLocaleLowerCase("en").includes(term) ||
      item.id.toLowerCase().includes(term);
    if (!matches) return false;
    if (filter === "attention") return item.status === "complete" &&
      (item.verdict === "dangerous" || item.verdict === "suspicious");
    if (filter === "dangerous" || filter === "suspicious") return item.status === "complete" && item.verdict === filter;
    if (filter === "active") return item.status === "pending" || item.status === "processing";
    if (filter === "complete") return item.status === "complete";
    return true;
  });
}
