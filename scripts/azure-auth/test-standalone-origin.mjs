// Gate 008C: real-server regression for the Azure auth/scan origin boundary behind a reverse proxy.
//
// Runs the REAL Next standalone server (the Dockerfile.azure-web entrypoint) bound to 0.0.0.0, either directly
// (--standalone <dir with server.js>) or inside the built image (--image <tag>, CI), and sends requests the way a
// TLS-terminating reverse proxy (Azure Container Apps ingress) does: Host / X-Forwarded-Host / X-Forwarded-Proto.
//
// Measured fact this guards (2026-11-15, Next 16 standalone): route handlers receive request.url =
// http(s)://0.0.0.0:<port>/... whatever Host or X-Forwarded-Host say; only the scheme follows X-Forwarded-Proto.
// Before Gate 008C, callback / login start / logout / scan create compared that origin with publicOrigin and
// therefore rejected every legitimate request.
//
// No network beyond loopback, no database, no Entra, no real credentials: the configuration below is generated
// per run (random state key, placeholder tenant) and only reaches code paths that never contact a provider or SQL.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [mode, target] = process.argv.slice(2);
if (!["--standalone", "--image"].includes(mode) || !target) {
  console.error("usage: test-standalone-origin.mjs --standalone <.next/standalone dir> | --image <docker tag>");
  process.exit(2);
}
const PUBLIC = "https://cbc.example";
const env = {
  CBC_AZURE_ONLY_MODE: "1",
  NODE_ENV: "production",
  HOSTNAME: "0.0.0.0",
  CBC_AZURE_PUBLIC_ORIGIN: PUBLIC,
  CBC_AZURE_OIDC_ISSUER: "https://cbc-test.ciamlogin.example/00000000-0000-4000-8000-000000000001/v2.0",
  CBC_AZURE_OIDC_CLIENT_ID: randomUUID(),
  CBC_AZURE_OIDC_STATE_ACTIVE_KID: "k1",
  CBC_AZURE_OIDC_STATE_KEYS: "k1:" + randomBytes(32).toString("base64url"),
  // The callback refuses to run without confidential-client material (fail closed). These placeholders are NOT
  // keys: the tested paths end before any token exchange, which is the only place they would be parsed.
  CBC_AZURE_OIDC_CLIENT_PRIVATE_KEY_PEM_B64: Buffer.from("placeholder - not a key").toString("base64"),
  CBC_AZURE_OIDC_CLIENT_CERT_PEM_B64: Buffer.from("placeholder - not a certificate").toString("base64"),
};

let base = "";
let stop = () => {};
let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log("PASS " + name); }
  catch (error) { failed++; console.log("FAIL " + name + ": " + String(error?.message ?? error)); }
}
const req = (p, init = {}) => fetch(base + p, { redirect: "manual", signal: AbortSignal.timeout(5000), ...init });
const proxied = { host: "cbc.example", "x-forwarded-host": "cbc.example", "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.7" };
const hostile = { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http", forwarded: "for=1.2.3.4;host=evil.example;proto=http" };
const noEvil = (res) => assert.ok(!JSON.stringify([...res.headers]).includes("evil.example"), "response headers mention evil.example");

async function start() {
  if (mode === "--standalone") {
    const server = path.resolve(target, "server.js");
    if (!existsSync(server)) throw new Error("server.js not found in " + target);
    const port = 40000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, [server], {
      cwd: path.dirname(server), env: { PATH: process.env.PATH, ...env, PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"],
    });
    stop = () => child.kill("SIGTERM");
    base = `http://127.0.0.1:${port}`;
  } else {
    const name = `cbc-origin-${process.pid}`;
    const args = ["run", "--detach", "--rm", "--name", name, "--publish", "127.0.0.1::3000"];
    for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
    const run = spawnSync("docker", [...args, target], { encoding: "utf8", timeout: 30000 });
    if (run.status !== 0) throw new Error("docker run failed: " + run.stderr);
    stop = () => spawnSync("docker", ["rm", "--force", name], { timeout: 30000 });
    const port = /127\.0\.0\.1:(\d+)/.exec(spawnSync("docker", ["port", name, "3000/tcp"], { encoding: "utf8" }).stdout)?.[1];
    if (!port) throw new Error("container port not bound to loopback");
    base = `http://127.0.0.1:${port}`;
  }
  for (let i = 0; i < 60; i++) {
    try { if ((await req("/api/healthz")).status === 200) return; } catch { /* starting */ }
    await delay(250);
  }
  throw new Error("server did not become healthy");
}

async function main() {
  await start();

  // ---- logout: the clearest observable (no session cookie -> no SQL; old code answered 403) ----------------
  await check("O1 proxied same-origin logout is accepted: 303 to the configured origin, session cookie cleared", async () => {
    const res = await req("/auth/azure/logout", { method: "POST", headers: { ...proxied, origin: PUBLIC, "sec-fetch-site": "same-origin" } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), PUBLIC + "/azure");
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("__Host-cbc-session=;")), "session cookie not cleared");
  });
  await check("O2 hostile Host / X-Forwarded-* / Forwarded cannot change the logout redirect", async () => {
    const res = await req("/auth/azure/logout", { method: "POST", headers: { ...hostile, origin: PUBLIC, "sec-fetch-site": "same-origin" } });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), PUBLIC + "/azure");
    noEvil(res);
  });
  await check("O3 cross-site Origin on a proxied logout is refused (CSRF)", async () => {
    for (const origin of ["https://evil.example", "http://cbc.example", "null"]) {
      const res = await req("/auth/azure/logout", { method: "POST", headers: { ...proxied, origin, "sec-fetch-site": "cross-site" } });
      assert.equal(res.status, 403, "origin " + origin);
      assert.deepEqual(res.headers.getSetCookie(), []);
    }
  });

  // ---- callback: every outcome redirects only to the configured origin -------------------------------------
  await check("O4 proxied provider-error callback with hostile headers redirects only to the configured origin", async () => {
    const res = await req("/auth/callback?error=access_denied&error_description=x", { headers: hostile });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), PUBLIC + "/azure");
    assert.ok(res.headers.getSetCookie().some((c) => c.startsWith("__Secure-cbc-oidc=;")), "login-state cookie not cleared");
    noEvil(res);
  });
  await check("O5 attacker-supplied redirect_uri / next parameters never become the redirect", async () => {
    for (const q of ["redirect_uri=https%3A%2F%2Fevil.example%2Fauth%2Fcallback", "next=https%3A%2F%2Fevil.example"]) {
      const res = await req("/auth/callback?code=abc&state=" + "s".repeat(43) + "&" + q, { headers: hostile });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get("location"), PUBLIC + "/azure");
      assert.ok(!res.headers.getSetCookie().some((c) => c.startsWith("__Host-cbc-session=") && !c.startsWith("__Host-cbc-session=;")), "session issued");
      noEvil(res);
    }
  });

  // ---- scan create: CSRF by browser Origin, then authentication (old code answered 403 before auth) --------
  await check("O6 proxied same-origin scan POST without a session reaches authentication (401, not 403)", async () => {
    const res = await req("/api/azure/scans", { method: "POST",
      headers: { ...proxied, origin: PUBLIC, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ input_type: "url", raw_input: "https://example.org/" }) });
    assert.equal(res.status, 401);
  });
  await check("O7 proxied scan POST with a cross-site Origin is refused (403)", async () => {
    const res = await req("/api/azure/scans", { method: "POST",
      headers: { ...hostile, origin: "https://evil.example", "sec-fetch-site": "cross-site", "content-type": "application/json" },
      body: JSON.stringify({ input_type: "url", raw_input: "https://example.org/" }) });
    assert.equal(res.status, 403);
  });
}

let finished = false;
process.on("beforeExit", () => { if (!finished) { console.log("FAIL run did not finish"); process.exitCode = 1; } });
main()
  .catch((e) => { failed++; console.log("FAIL setup: " + String(e?.message ?? e)); })
  .finally(() => {
    stop();
    finished = true;
    console.log(`\n=== Gate 008C standalone origin (${mode.slice(2)}): ${passed} passed, ${failed} failed ===`);
    process.exitCode = failed === 0 ? 0 : 1;
  });
