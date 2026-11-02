import assert from "node:assert/strict";
import { classifyAzureWebPath, isAzureWebPath } from "../../src/security/azureWebRouting.ts";

const ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
let count = 0;
function check(name: string, path: string, expected: "allow" | "redirect" | "deny") {
  assert.equal(classifyAzureWebPath(path), expected, name);
  count++;
}
check("root goes to Azure UI", "/", "redirect");
for (const path of [
  "/azure", "/azure/", "/auth/azure/start", "/auth/azure/logout",
  "/auth/callback", "/api/azure/scans", `/api/azure/scans/${ID}`, "/api/healthz",
]) check("Azure route is reachable without legacy middleware", path, "allow");
for (const path of [
  "/login", "/register", "/dashboard", "/scan", "/history",
  "/api/scans", "/api/inngest", "/auth/signout", "/api/azure",
  "/api/azure/scans/bad", `/api/azure/scans/${ID}/evidence`,
  "/api/azure/scans/", "/azure-old", "/azure/dashboard",
  "/auth/azure/start/extra", "/auth/callback/extra",
  "/api/healthz/extra", "//azure", "/.well-known/security.txt",
]) check("legacy and unknown routes fail closed", path, "deny");
assert.equal(isAzureWebPath("/api/azure/scans"), true);
assert.equal(isAzureWebPath("/api/azure/scans/not-a-uuid"), false);
console.log(`Azure-only web routing: ${count + 2} offline assertions passed`);
