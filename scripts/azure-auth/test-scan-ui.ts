import assert from "node:assert/strict";
import { validateSubmittedUrl, parseScanCreated, parseScanRead, scanPresentation } from "../../src/client/azureScanUi.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let count = 0;
function check(name: string, fn: () => void) { fn(); count++; console.log("PASS", name); }
check("accept canonical HTTPS URL", () => assert.equal(validateSubmittedUrl(" https://example.com/a "), "https://example.com/a"));
for (const raw of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com", "https://user:pass@example.com", "https://example.com/#secret", "https://example.com/\nfoo", ""]) {
  check("reject malformed or unsupported URL", () => assert.equal(validateSubmittedUrl(raw), null));
}
check("accept canonical creation ID", () => assert.equal(parseScanCreated({ id: ID, status: "pending" }), ID));
for (const body of [null, {}, { id: ID.toUpperCase(), status: "pending" }, { id: ID, status: "complete" }]) {
  check("reject malformed creation response", () => assert.throws(() => parseScanCreated(body)));
}
const payload = { scan: { id: ID, input_type: "url", raw_input: "https://example.com", status: "complete", verdict: "unknown" }, evidence: [] };
check("parse tenant-filtered read shape", () => assert.equal(parseScanRead(payload, ID).scan.id, ID));
check("reject mismatched scan ID", () => assert.throws(() => parseScanRead(payload, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")));
check("reject wrong scan type", () => assert.throws(() => parseScanRead({ ...payload, scan: { ...payload.scan, input_type: "email" } }, ID)));
check("reject unbounded evidence", () => assert.throws(() => parseScanRead({ ...payload, evidence: Array(501).fill({ title: "a", detail: null }) }, ID)));
check("reject malformed evidence", () => assert.throws(() => parseScanRead({ ...payload, evidence: [{ title: 7, detail: null }] }, ID)));
check("unknown verdict never says safe", () => assert.match(scanPresentation(payload.scan as ReturnType<typeof parseScanRead>["scan"]).label, /not confirmed/i));
check("failed scan never says safe", () => assert.match(scanPresentation({ ...payload.scan, status: "failed" } as ReturnType<typeof parseScanRead>["scan"]).description, /not assume/i));
check("dangerous result explicitly warns", () => assert.match(scanPresentation({ ...payload.scan, verdict: "dangerous" } as ReturnType<typeof parseScanRead>["scan"]).label, /do not open/i));
console.log(`Azure scan UI: ${count} offline assertions passed`);
