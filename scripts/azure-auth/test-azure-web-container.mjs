// Real-container HTTP smoke tests for the Azure-only Next.js image.
// Requires Docker; intentionally runs with NO Supabase, Entra, database or provider secrets.
// This is a pre-deployment test, not an authenticated end-to-end test.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const image = process.argv[2] ?? "cbc-azure-web:ci";
const name = `cbc-azure-web-smoke-${process.pid}`;
let started = false;
let assertions = 0;

function docker(...args) {
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: 30000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Docker command failed (${args[0]}): ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  }
  return result.stdout.trim();
}
function check(condition, message) {
  assert.ok(condition, message);
  assertions++;
}
async function request(base, path, init = {}) {
  return fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(5000), ...init });
}
async function ready(base) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const response = await request(base, "/api/healthz");
      if (response.status === 200) return;
    } catch { /* Container is still starting. */ }
    await delay(300);
  }
  throw new Error("Azure web container did not become healthy within 15 seconds");
}

try {
  docker("run", "--detach", "--rm", "--name", name,
    "--publish", "127.0.0.1::3000",
    "--env", "CBC_AZURE_ONLY_MODE=1",
    "--env", "NODE_ENV=production", image);
  started = true;
  const portOutput = docker("port", name, "3000/tcp");
  const port = /^127\.0\.0\.1:(\d+)$/m.exec(portOutput)?.[1];
  check(Boolean(port), "Docker must bind the test port to loopback only");
  const base = `http://127.0.0.1:${port}`;
  await ready(base);

  const health = await request(base, "/api/healthz");
  check(health.status === 200, "health endpoint must work without Supabase");
  check((await health.json()).status === "ok", "health response must be well-formed");

  const root = await request(base, "/");
  check(root.status === 307, "root must redirect to Azure UI");
  check(new URL(root.headers.get("location"), base).pathname === "/azure",
    "root must not redirect to a legacy login or dashboard");

  const ui = await request(base, "/azure");
  check(ui.status === 200, "Azure scan UI must render without Supabase");
  const html = await ui.text();
  check(html.includes("Link intelligence") && html.includes("URL to investigate"), "security overview and scan form must be visible");
  check(html.includes("/auth/azure/start"), "Entra login entrypoint must be visible");
  check(html.includes("Analyze URL"), "scan submission control must be visible");
  check(html.includes("Investigation"), "investigation panel must be visible");
  check(html.includes("Recent scan history"), "real history panel must be visible");
  check(html.includes("Light") && html.includes("Dark") && html.includes("System"),
    "all three theme choices must be visible");

  for (const path of ["/login", "/register", "/dashboard", "/api/inngest",
    "/api/inngest/hook.js", "/api/legacy.svg", "/api/azure/scans/not-a-uuid"]) {
    const response = await request(base, path);
    check(response.status === 404, `Legacy or invalid path must be blocked: ${path}`);
    check(response.headers.get("cache-control")?.includes("no-store"),
      `Denied path must not be cached: ${path}`);
  }

  const history = await request(base, "/api/azure/history");
  check(history.status === 401, "history requires an authenticated Azure session");
  check(history.headers.get("cache-control")?.includes("no-store"),
    "history authorization responses must not be cached");
  check(!(await history.text()).includes("SECRET"), "history errors must not leak credentials");

  const legacyPost = await request(base, "/api/inngest", { method: "POST" });
  check(legacyPost.status === 404, "legacy Inngest POST must be blocked");

  const scan = await request(base, "/api/azure/scans", {
    method: "POST",
    headers: { "origin": base, "content-type": "application/json" },
    body: JSON.stringify({ input_type: "url", raw_input: "https://example.com" }),
  });
  check(scan.status === 503, "scan creation must fail closed without Azure configuration");
  check(scan.headers.get("cache-control")?.includes("no-store"),
    "unconfigured scan responses must not be cached");
  const body = await scan.text();
  check(!/supabase|postgres|password|secret|stack trace/i.test(body),
    "scan failure must not disclose internal configuration or credentials");

  console.log(`Azure web container HTTP smoke: ${assertions} assertions passed`);
} finally {
  if (started) {
    const cleanup = spawnSync("docker", ["rm", "--force", name],
      { encoding: "utf8", timeout: 15000 });
    if (cleanup.status !== 0 && !/No such container/.test(cleanup.stderr ?? "")) {
      console.error("Warning: could not remove smoke-test container");
    }
  }
}
