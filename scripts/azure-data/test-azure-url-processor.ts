// No DNS, HTTP, Azure, DB, API keys or paid provider calls.
import assert from "node:assert/strict";
import { canonicalPublicUrl, createUrlReputationProcessor } from "../../src/server/workers/azureUrlProcessor.ts";
import type { ScanJob } from "../../src/server/workers/azureScanWorker.ts";
const job = (rawInput: string, inputType: ScanJob["inputType"] = "url"): ScanJob =>
  ({ scanId: "11111111-1111-4111-8111-111111111111", rawInput, inputType, signal: new AbortController().signal });
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name, e); process.exitCode = 1; }
}
await check("U01 canonical public HTTPS and strip fragments", async () => {
  assert.equal(canonicalPublicUrl("https://Example.COM/a?x=1#secret"), "https://example.com/a?x=1");
});
await check("U02 block private/loopback IPs and numeric IPv4 aliases", async () => {
  for (const host of ["127.0.0.1", "10.0.0.1", "192.168.1.2", "169.254.169.254",
    "2130706433", "0x7f000001", "[::1]", "[::ffff:127.0.0.1]"]) {
    assert.equal(canonicalPublicUrl("http://" + host + "/"), null, host);
  }
});
await check("U03 block internal/reserved names and single-label hosts", async () => {
  for (const host of ["localhost", "foo.localhost", "metadata.internal", "foo.local",
    "foo.test", "foo.example", "foo.onion", "foo.home.arpa", "intranet", "db"]) {
    assert.equal(canonicalPublicUrl("http://" + host + "/"), null, host);
  }
});
await check("U04 reject credentials, unusual ports and non-web schemes", async () => {
  for (const url of ["https://user:pass@example.com/", "http://example.com:8080/",
    "file:///etc/passwd", "ftp://example.com/", "http://example.com\\@127.0.0.1/",
    "https://example.com/\n", "https://example.com/ a"]) {
    assert.equal(canonicalPublicUrl(url), null, url);
  }
});
await check("U05 reject oversized URLs", async () => {
  assert.equal(canonicalPublicUrl("https://example.com/" + "x".repeat(2100)), null);
});
await check("U06 never look up rejected URLs or unsupported input", async () => {
  let calls = 0;
  const processor = createUrlReputationProcessor(async () => { calls++; return { threatTypes: [] }; });
  assert.equal((await processor(job("http://localhost/"))).status, "failed");
  assert.equal((await processor(job("x@y.com", "email"))).status, "failed");
  assert.equal(calls, 0);
});
await check("U07 threat matches become dangerous with DB-valid evidence", async () => {
  const processor = createUrlReputationProcessor(async () => ({ threatTypes: ["MALWARE", "SOCIAL_ENGINEERING"] }));
  const result = await processor(job("https://example.org/path"));
  assert.equal(result.status, "complete"); assert.equal(result.verdict, "dangerous");
  assert.equal(result.evidenceItems[0].severity, "critical");
  assert.deepEqual((result.vendorResults[0].raw_response as { threat_types: string[] }).threat_types,
    ["MALWARE", "SOCIAL_ENGINEERING"]);
});
await check("U08 no match is UNKNOWN, never safe", async () => {
  const processor = createUrlReputationProcessor(async () => ({ threatTypes: [] }));
  const result = await processor(job("https://example.org/"));
  assert.equal(result.verdict, "unknown"); assert.equal(result.riskScore, null);
  assert.match(result.explanation ?? "", /does not establish/);
});
await check("U09 provider errors propagate for lease-based retry", async () => {
  const processor = createUrlReputationProcessor(async () => { throw Error("provider unavailable"); });
  await assert.rejects(() => processor(job("https://example.org/")));
});
await check("U10 malformed threat categories fail closed", async () => {
  for (const threats of [["INVALID"], ["MALWARE", "INVALID"], Array(5).fill("MALWARE")]) {
    const processor = createUrlReputationProcessor(async () => ({ threatTypes: threats }));
    await assert.rejects(() => processor(job("https://example.org/")));
  }
});
await check("U11 aborted work never invokes provider", async () => {
  let calls = 0; const controller = new AbortController(); controller.abort();
  const processor = createUrlReputationProcessor(async () => { calls++; return { threatTypes: [] }; });
  await assert.rejects(() => processor({ ...job("https://example.org/"), signal: controller.signal }));
  assert.equal(calls, 0);
});
await check("U12 provider never receives URL fragment or lease token", async () => {
  let seen = "";
  const processor = createUrlReputationProcessor(async url => { seen = url; return { threatTypes: [] }; });
  await processor(job("https://example.org/?a=b#private"));
  assert.equal(seen, "https://example.org/?a=b");
  assert.equal(seen.includes("11111111"), false);
});
console.log("\n=== Azure URL processor offline: " + passed + " passed ===");
if (passed !== 12) process.exitCode = 1;
