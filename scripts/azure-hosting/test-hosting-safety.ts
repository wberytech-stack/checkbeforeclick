/**
 * Gate 006B - static safety tests for the Azure hosting artifacts.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/azure-hosting/test-hosting-safety.ts
 *
 * Reads files only. No network, no Docker, no Azure. Asserts the invariants of
 * AGENTS.md section 20 and Gate 006A section 6: the deploy workflow is manual,
 * founder-gated, OIDC-only and secret-free; the image is non-root, pinned and
 * secret-free by construction; the Bicep references Key Vault secrets by name only.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const ROOT = process.cwd();
const YAML = createRequire(path.join(ROOT, "package.json"))("yaml") as typeof import("yaml");
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

let failures = 0;
let passes = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passes++;
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

// Patterns that must never appear in committed hosting artifacts.
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["JWT", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ["Stripe key", /\b(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/],
  ["Anthropic key", /sk-ant-[A-Za-z0-9_-]{8,}/],
  ["Google API key", /AIza[0-9A-Za-z_-]{30,}/],
  ["Resend key", /\bre_[A-Za-z0-9]{20,}/],
  ["Inngest signing key", /signkey-(prod|test|branch)-[0-9a-f]{16,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["connection string password", /postgres(ql)?:\/\/[^:\s/]+:[^@\s]+@/],
  ["ACR admin password", /adminUserEnabled:\s*true/],
];
function noSecrets(label: string, text: string) {
  const hits = SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([n]) => n);
  check(`${label}: no secret patterns`, hits.length === 0, hits.join(", "));
}

// ---------------------------------------------------------------- workflow
const wfText = read(".github/workflows/azure-deploy.yml");
type Step = { uses?: string; with?: Record<string, unknown> };
type Job = { if?: unknown; needs?: string | string[]; environment?: unknown; permissions?: Record<string, string>; steps?: Step[] };
type Input = { type?: string; options?: string[]; required?: boolean };
type Workflow = { on?: { workflow_dispatch?: { inputs?: Record<string, Input> } }; permissions?: unknown; jobs?: Record<string, Job> };
const wf = YAML.parse(wfText) as Workflow & Record<string, unknown>;
const on = (wf.on ?? wf["true"]) as Workflow["on"];
const triggers = on && typeof on === "object" ? Object.keys(on) : [String(on)];
check("workflow: only trigger is workflow_dispatch", triggers.length === 1 && triggers[0] === "workflow_dispatch", triggers.join(","));
check("workflow: no push/pull_request/schedule/workflow_run text trigger",
  !/^\s*(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m.test(wfText));
const inputs: Record<string, Input> = on?.workflow_dispatch?.inputs ?? {};
check("workflow: environment input is staging|production choice",
  inputs.environment?.type === "choice" &&
  JSON.stringify(inputs.environment?.options) === JSON.stringify(["staging", "production"]));
check("workflow: commit input required", inputs.commit?.required === true);
check("workflow: top-level permissions are contents: read only",
  JSON.stringify(wf.permissions) === JSON.stringify({ contents: "read" }));
check("workflow: no secrets.* references", !/secrets\./.test(wfText));
check("workflow: no client-secret / creds input", !/client-secret|creds:/.test(wfText));

const jobs: Record<string, Job> = wf.jobs ?? {};
for (const [id, job] of Object.entries(jobs)) {
  check(`workflow: job ${id} is gated on CBC_AZURE_DEPLOY_ENABLED == 'enabled'`,
    typeof job.if === "string" && job.if.includes("vars.CBC_AZURE_DEPLOY_ENABLED == 'enabled'"));
  const perms: Record<string, string> = job.permissions ?? {};
  const writes = Object.entries(perms).filter(([, v]) => v === "write").map(([k]) => k);
  check(`workflow: job ${id} writes at most id-token`, writes.every((k) => k === "id-token"), writes.join(","));
  const usesLogin = (job.steps ?? []).some((s) => typeof s.uses === "string" && s.uses.startsWith("azure/login@"));
  if (usesLogin || perms["id-token"] === "write") {
    check(`workflow: job ${id} with Azure access runs in azure-<env> environment`,
      job.environment === "azure-${{ inputs.environment }}");
    check(`workflow: job ${id} needs build`, job.needs === "build" || (Array.isArray(job.needs) && job.needs.includes("build")));
  } else {
    check(`workflow: job ${id} has no id-token permission`, perms["id-token"] === undefined);
  }
  for (const s of job.steps ?? []) {
    if (s.uses === "actions/setup-node@v4") {
      check(`workflow: job ${id} pins Node 24.14.0`, s.with?.["node-version"] === "24.14.0");
    }
  }
}
check("workflow: deploy job exists with OIDC azure/login", Object.values(jobs).some((j) =>
  (j.steps ?? []).some((s) => typeof s.uses === "string" && s.uses.startsWith("azure/login@"))));
check("workflow: requires commit on origin/master", /merge-base --is-ancestor "\$COMMIT" origin\/master/.test(wfText));
check("workflow: 40-hex commit validation", wfText.includes("^[0-9a-f]{40}$"));
check("workflow: only NEXT_PUBLIC_* and CBC_BUILD_SHA build args",
  [...wfText.matchAll(/--build-arg\s+([A-Z0-9_]+)=/g)].every((m) => m[1].startsWith("NEXT_PUBLIC_") || m[1] === "CBC_BUILD_SHA"));
check("workflow: no merge/approve/ready/force-push commands",
  !/gh pr (merge|ready|review)|push --force|git push/.test(wfText));
check("workflow: health check on /api/healthz", wfText.includes("/api/healthz"));
noSecrets("workflow", wfText);

// ---------------------------------------------------------------- Dockerfile
const df = read("Dockerfile");
const froms = [...df.matchAll(/^FROM\s+(\S+)/gm)].map((m) => m[1]);
check("Dockerfile: base image pinned to node:24.14.0", /^ARG NODE_IMAGE=node:24\.14\.0-/m.test(df) && froms.every((f) => f === "${NODE_IMAGE}"));
const lastUser = [...df.matchAll(/^USER\s+(\S+)/gm)].map((m) => m[1]).pop();
check("Dockerfile: final USER is non-root node", lastUser === "node");
check("Dockerfile: npm ci with --ignore-scripts", /npm ci --ignore-scripts/.test(df));
check("Dockerfile: exposes 3000", /^EXPOSE 3000$/m.test(df));
check("Dockerfile: HEALTHCHECK uses /api/healthz", /HEALTHCHECK[\s\S]*\/api\/healthz/.test(df));
const args = [...df.matchAll(/^ARG\s+([A-Z0-9_]+)/gm)].map((m) => m[1]);
check("Dockerfile: ARGs are public or non-secret only",
  args.every((a) => a === "NODE_IMAGE" || a === "CBC_BUILD_SHA" || a.startsWith("NEXT_PUBLIC_")), args.join(","));
check("Dockerfile: never copies .env files", !/COPY[^\n]*\.env/.test(df));
check("Dockerfile: no secret env names", !/(SERVICE_ROLE|SIGNING_KEY|EVENT_KEY|WEB_RISK_API_KEY|SECRET|PASSWORD)/.test(df.replace(/^#.*$/gm, "")));
noSecrets("Dockerfile", df);

// ---------------------------------------------------------------- .dockerignore
const di = read(".dockerignore").split(/\r?\n/).map((l) => l.trim());
for (const p of [".env", ".env.*", "**/.env", "**/.env.*", ".git", "node_modules", ".next", "*.pem", "*.key", ".npmrc"]) {
  check(`.dockerignore: excludes ${p}`, di.includes(p));
}
check(".dockerignore: never re-includes .env", !di.some((l) => l.startsWith("!") && l.includes(".env")));

// ---------------------------------------------------------------- app wiring
check("next.config: output standalone", /output:\s*"standalone"/.test(read("next.config.ts")));
const health = read("app/api/healthz/route.ts");
check("healthz: no supabase / db / env access", !/supabase|from "pg"|process\.env/.test(health));
check("proxy: matcher excludes exactly api/healthz", read("proxy.ts").includes("api/healthz$|"));

// ---------------------------------------------------------------- Bicep
const bicepDir = "infra/azure/hosting";
const bicepFiles = [path.join(bicepDir, "main.bicep"), path.join(bicepDir, "modules", "web-app.bicep")];
const bicep = bicepFiles.map(read).join("\n");
for (const f of bicepFiles) noSecrets(f, read(f));
const params = JSON.parse(read(path.join(bicepDir, "main.parameters.json")));
noSecrets("main.parameters.json", read(path.join(bicepDir, "main.parameters.json")));
const pv = (k: string) => params.parameters[k]?.value;
check("bicep params: resource names match Gate 006A",
  pv("registryName") === "crcbcprodcc001" && pv("logAnalyticsName") === "log-cbc-prod-cc-001" &&
  pv("environmentName") === "cae-cbc-prod-cc-001" && pv("identityName") === "id-cbc-web-cc-001" &&
  pv("stagingAppName") === "ca-cbc-web-stg-cc-001" && pv("productionAppName") === "ca-cbc-web-prod-cc-001" &&
  pv("keyVaultName") === "kv-cbc-prod-cc-001");
for (const k of ["stagingSecretNames", "productionSecretNames"]) {
  const names = Object.values<string>(pv(k) ?? {});
  check(`bicep params: ${k} are Key Vault secret names (lowercase-dash, no values)`,
    names.length === 4 && names.every((n) => /^[a-z0-9-]{3,127}$/.test(n)), names.join(","));
}
for (const k of ["stagingPlainEnv", "productionPlainEnv"]) {
  const names = ((pv(k) ?? []) as Array<{ name: string }>).map((e) => e.name);
  check(`bicep params: ${k} holds no secret-named variables`,
    names.every((n: string) => !/(KEY|SECRET|PASSWORD|TOKEN)/.test(n)), names.join(","));
}
for (const t of [
  "Microsoft.ContainerRegistry/registries@", "Microsoft.OperationalInsights/workspaces@",
  "Microsoft.App/managedEnvironments@", "Microsoft.ManagedIdentity/userAssignedIdentities@",
  "Microsoft.App/containerApps@", "Microsoft.KeyVault/vaults@",
]) check(`bicep: declares ${t.replace(/@$/, "")}`, bicep.includes(t));
check("bicep: Key Vault is referenced as existing (never created)", /Microsoft\.KeyVault\/vaults@[^']+' existing/.test(bicep));
check("bicep: registry SKU Basic, admin user disabled", /name: 'Basic'/.test(bicep) && /adminUserEnabled: false/.test(bicep));
check("bicep: Log Analytics daily cap set", /dailyQuotaGb/.test(bicep));
check("bicep: AcrPull role id", bicep.includes("7f951dda-4ed3-4680-a7ca-43fe172d538d"));
check("bicep: Key Vault Secrets User role id", bicep.includes("4633458b-17de-408a-b874-0445c86b69e6"));
check("bicep: secrets via keyVaultUrl + identity only", /keyVaultUrl:/.test(bicep) && !/\bvalue:\s*'[^']*'/.test(bicep.split("secrets:")[1]?.split("template:")[0] ?? ""));
check("bicep: staging minReplicas 0, production minReplicas 1",
  /name: 'web-staging'[\s\S]*?minReplicas: 0/.test(bicep) && /name: 'web-production'[\s\S]*?minReplicas: 1/.test(bicep));
check("bicep: probes on /api/healthz port 3000", /path: '\/api\/healthz'/.test(bicep) && /targetPort: 3000/.test(bicep));
check("bicep: ingress https only", /allowInsecure: false/.test(bicep));
check("bicep: apps are Phase B only (deployApps, default false)",
  /param deployApps bool = false/.test(bicep) && /module staging '[^']+' = if \(deployApps\)/.test(bicep) &&
  /module production '[^']+' = if \(deployApps\)/.test(bicep));
check("bicep: no placeholder/bootstrap image that would fail the 3000 probe", !/quickstart/.test(bicep));

// ---------------------------------------------------------------- no stray workflows deploy
for (const f of readdirSync(path.join(ROOT, ".github", "workflows"))) {
  if (f === "azure-deploy.yml") continue;
  const t = read(path.join(".github", "workflows", f));
  check(`${f}: does not call Azure`, !/azure\/login|az containerapp|az acr/.test(t));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
