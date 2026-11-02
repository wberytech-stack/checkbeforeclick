// Fake fetch only: validates endpoint pinning, fail-closed behavior, no target fetch.
import assert from "node:assert/strict";
import { createWebRiskLookup } from "../../src/server/workers/azureWebRiskLookup.ts";
const KEY = "a".repeat(32);
const signal = new AbortController().signal;
let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (e) { console.error("FAIL " + name, e); process.exitCode = 1; }
}
await check("R01 fixed provider origin; no target HTTP request", async () => {
  let count = 0;
  const lookup = createWebRiskLookup({ apiKey: KEY, fetchImpl: async (url, init) => {
    count++;
    const endpoint = new URL(String(url));
    assert.equal(endpoint.origin, "https://webrisk.googleapis.com");
    assert.equal(endpoint.pathname, "/v1/uris:search");
    assert.equal(endpoint.searchParams.get("uri"), "https://example.org/a?token=private");
    assert.equal(endpoint.searchParams.get("key"), KEY);
    assert.deepEqual(endpoint.searchParams.getAll("threatTypes"),
      ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"]);
    assert.equal(init?.redirect, "manual"); assert.equal(init?.cache, "no-store");
    return new Response("{}", { status: 200 });
  } });
  assert.deepEqual(await lookup("https://example.org/a?token=private", signal), { threatTypes: [] });
  assert.equal(count, 1);
});
await check("R02 positive match returns known category", async () => {
  const lookup = createWebRiskLookup({ apiKey: KEY, fetchImpl: async () =>
    new Response('{"threat":{"threatTypes":["MALWARE"]}}', { status: 200 }) });
  assert.deepEqual(await lookup("https://example.org/", signal), { threatTypes: ["MALWARE"] });
});
await check("R02b empty threat object is no match, never safe", async () => {
  const lookup = createWebRiskLookup({ apiKey: KEY, fetchImpl: async () =>
    new Response('{"threat":{}}', { status: 200 }) });
  assert.deepEqual(await lookup("https://example.org/", signal), { threatTypes: [] });
});
await check("R03 redirect, provider errors and malformed JSON fail closed", async () => {
  for (const response of [new Response("", { status: 302 }),
    new Response("secret provider failure", { status: 403 }),
    new Response("not-json", { status: 200 }),
    new Response('{"error":"unauthorized"}', { status: 200 }),
    new Response('{"threat":{"threatTypes":["UNKNOWN"]}}', { status: 200 })]) {
    const lookup = createWebRiskLookup({ apiKey: KEY, fetchImpl: async () => response });
    await assert.rejects(() => lookup("https://example.org/", signal),
      e => e instanceof Error && e.message === "Reputation provider unavailable");
  }
});
await check("R04 response size cap rejects oversized body", async () => {
  const lookup = createWebRiskLookup({ apiKey: KEY, fetchImpl: async () =>
    new Response("x".repeat(17000), { status: 200 }) });
  await assert.rejects(() => lookup("https://example.org/", signal));
});
await check("R05 aborted signal never calls fetch", async () => {
  const controller = new AbortController(); controller.abort(); let count = 0;
  const lookup = createWebRiskLookup({ apiKey: KEY, fetchImpl: async () => {
    count++; return new Response("{}", { status: 200 });
  } });
  await assert.rejects(() => lookup("https://example.org/", controller.signal));
  assert.equal(count, 0);
});
await check("R06 invalid API key rejected before any network", async () => {
  for (const apiKey of ["", "bad", "a?secret=1", "a".repeat(300)]) {
    assert.throws(() => createWebRiskLookup({ apiKey }));
  }
});
await check("R07 provider exception sanitized", async () => {
  const lookup = createWebRiskLookup({ apiKey: KEY, fetchImpl: async () => {
    throw Error("token=" + KEY + " url=https://example.org/private");
  } });
  await assert.rejects(() => lookup("https://example.org/", signal),
    e => e instanceof Error && e.message === "Reputation provider unavailable");
});
console.log("\n=== Azure Web Risk lookup offline: " + passed + " passed ===");
if (passed !== 8) process.exitCode = 1;
