import assert from "node:assert/strict";
import { filterAzureHistory, historyRiskLabel, parseAzureScanHistory } from "../../src/client/azureHistoryUi.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ID2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const row = { id: ID, raw_input: "https://example.test/a", status: "complete", verdict: "dangerous", created_at: "2026-11-02T00:00:00.000Z" };
let count = 0;
function check(name: string, fn: () => void) { fn(); count++; console.log("PASS", name); }
check("accept valid bounded history", () => assert.deepEqual(parseAzureScanHistory({ scans: [row], has_more: false }).scans[0], row));
check("empty history is valid", () => assert.deepEqual(parseAzureScanHistory({ scans: [], has_more: false }).scans, []));
check("has_more is preserved", () => assert.equal(parseAzureScanHistory({ scans: [row], has_more: true }).has_more, true));
for (const bad of [null, {}, { scans: [], has_more: "false" }, { scans: Array(51).fill(row), has_more: true }]) {
  check("reject malformed or unbounded history", () => assert.throws(() => parseAzureScanHistory(bad)));
}
for (const bad of [
  { ...row, id: ID.toUpperCase() }, { ...row, raw_input: 1 }, { ...row, status: "unknown" },
  { ...row, status: { toString: () => "complete" } },
  { ...row, verdict: 1 }, { ...row, verdict: "x".repeat(65) }, { ...row, created_at: "not-a-date" }, { ...row, created_at: "2026-11-02" },
  { ...row, created_at: "2026-02-31T00:00:00.000Z" },
]) {
  check("reject malformed history row", () => assert.throws(() => parseAzureScanHistory({ scans: [bad], has_more: false })));
}
check("duplicate scan IDs are rejected", () => assert.throws(() => parseAzureScanHistory({ scans: [row, row], has_more: false })));
check("dangerous verdict is explicit", () => assert.equal(historyRiskLabel(row as ReturnType<typeof parseAzureScanHistory>["scans"][number]), "Dangerous"));
check("unknown verdict is not called safe", () => assert.equal(historyRiskLabel({ ...row, verdict: "safe" } as ReturnType<typeof parseAzureScanHistory>["scans"][number]), "Unconfirmed"));
const rows = parseAzureScanHistory({ scans: [row, { ...row, id: ID2, raw_input: "https://other.test/", status: "pending", verdict: null }], has_more: false }).scans;
check("filter by URL", () => assert.deepEqual(filterAzureHistory(rows, "EXAMPLE", "all").map(x => x.id), [ID]));
check("filter by scan ID", () => assert.deepEqual(filterAzureHistory(rows, ID2, "all").map(x => x.id), [ID2]));
check("filter attention", () => assert.deepEqual(filterAzureHistory(rows, "", "attention").map(x => x.id), [ID]));
check("filter active", () => assert.deepEqual(filterAzureHistory(rows, "", "active").map(x => x.id), [ID2]));
check("filter complete", () => assert.deepEqual(filterAzureHistory(rows, "", "complete").map(x => x.id), [ID]));
console.log(`Azure history UI: ${count} offline assertions passed`);
