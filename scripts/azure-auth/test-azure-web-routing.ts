import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyAzureWebPath, isAzureWebPath } from "../../src/security/azureWebRouting.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let count = 0;
function check(name: string, path: string, expected: "allow" | "redirect" | "deny") {
  assert.equal(classifyAzureWebPath(path), expected, name);
  count++;
}
check("root goes to Azure welcome page", "/", "redirect");
for (const path of [
  "/azure", "/azure/", "/azure/welcome", "/auth/azure/start", "/auth/azure/logout",
  "/auth/callback", "/api/azure/scans", "/api/azure/history", `/api/azure/scans/${ID}`, "/api/healthz",
]) check("Azure route is reachable without legacy middleware", path, "allow");
for (const path of [
  "/login", "/register", "/dashboard", "/scan", "/history",
  "/api/scans", "/api/inngest", "/api/inngest/hook.js", "/api/legacy.svg", "/auth/signout", "/api/azure",
  "/api/azure/scans/bad", `/api/azure/scans/${ID}/evidence`,
  "/api/azure/scans/", "/azure-old", "/azure/dashboard", "/azure/welcome/extra",
  "/auth/azure/start/extra", "/auth/callback/extra",
  "/api/healthz/extra", "//azure", "/.well-known/security.txt",
]) check("legacy and unknown routes fail closed", path, "deny");
// A broad extension-based matcher exclusion silently bypasses the proxy and
// re-exposes old dynamic handlers. Lock down the Next matcher contract too.
const proxy = readFileSync(new URL("../../proxy.ts", import.meta.url), "utf8");
assert.ok(proxy.includes('"/((?!_next/static|_next/image|favicon.ico|api/healthz$).*)"'));
assert.equal(isAzureWebPath("/api/azure/scans"), true);
assert.equal(isAzureWebPath("/api/azure/scans/not-a-uuid"), false);
console.log(`Azure-only web routing: ${count + 3} offline assertions passed`);
