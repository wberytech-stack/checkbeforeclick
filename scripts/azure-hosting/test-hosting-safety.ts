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
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const YAML = createRequire(path.join(ROOT, "package.json"))("yaml") as typeof import("yaml");
// Line endings are normalized so the checks give the same result on an LF checkout
// (CI) and a CRLF checkout (Windows with core.autocrlf=true).
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n?/g, "\n");

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
  check(`workflow: job ${id} only runs when dispatched from master`,
    typeof job.if === "string" && job.if.includes("github.ref == 'refs/heads/master'"));
  const perms: Record<string, string> = job.permissions ?? {};
  const writes = Object.entries(perms).filter(([, v]) => v === "write").map(([k]) => k);
  check(`workflow: job ${id} writes at most id-token`, writes.every((k) => k === "id-token"), writes.join(","));
  const usesLogin = (job.steps ?? []).some((s) => typeof s.uses === "string" && s.uses.startsWith("azure/login@"));
  if (usesLogin || perms["id-token"] === "write") {
    // Staging-only jobs (Gate 006C) name azure-staging directly and must be gated to staging.
    check(`workflow: job ${id} with Azure access runs in azure-<env> environment`,
      job.environment === "azure-${{ inputs.environment }}" ||
      (job.environment === "azure-staging" && typeof job.if === "string" && job.if.includes("inputs.environment == 'staging'")));
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
check("workflow: waits for the new revision (latest == latestReady, image matches)",
  wfText.includes("properties.latestReadyRevisionName") && wfText.includes('[ "$image" = "$want" ]'));
// PR #32 review: in the container the request origin is the bind address, so the
// auth callback needs an explicit public origin for every Azure environment.
check("workflow: NEXT_PUBLIC_APP_URL required as an https origin",
  wfText.includes('[[ "$app" =~ ^https://[a-z0-9.-]+$ ]]'));
noSecrets("workflow", wfText);

// ---------------------------------------------------------------- single-dispatch staging (Gate 006C)
// Production keeps the image-only deploy job. Staging is one job behind one azure-staging
// approval: push and pin the digest, checked what-if, deploy the same digest, health,
// read-only configuration check, in that order. Bicep is applied only for staging.
{
  const stg = jobs.staging;
  const steps = (stg?.steps ?? []).map((s) => JSON.stringify(s));
  const at = (text: string) => steps.findIndex((s) => s.includes(text));
  check("staging: deploy job runs for production only",
    typeof jobs.deploy?.if === "string" && jobs.deploy.if.includes("inputs.environment == 'production'"));
  check("staging: staging job exists, gated to staging, in azure-staging",
    !!stg && typeof stg.if === "string" && stg.if.includes("inputs.environment == 'staging'") && stg.environment === "azure-staging");
  check("staging: exactly one job runs in azure-staging (one approval per dispatch)",
    Object.values(jobs).filter((j) => j.environment === "azure-staging").length === 1);
  check("staging: permissions are exactly id-token: write, contents: read",
    JSON.stringify(stg?.permissions) === JSON.stringify({ "id-token": "write", contents: "read" }));
  check("staging: checkout does not persist credentials",
    (stg?.steps ?? []).some((s) => s.uses === "actions/checkout@v4" && s.with?.["persist-credentials"] === false));
  const order = [
    at("azure/login@"), at("docker push"), at("az deployment group what-if"), at("staging-guard.mjs whatif"),
    at("az deployment group create"), at("latestReadyRevisionName"), at("staging-guard.mjs config"),
  ];
  check("staging: sign-in, push, what-if, guard, create, wait, config check run in that order",
    order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1] || k === 3)), order.join(","));
  check("staging: what-if and its guard share one step (no deployment unless the guard passes)",
    order[2] >= 0 && order[2] === order[3]);
  check("staging: the configuration check is the last step", order[6] === steps.length - 1);
  check("staging: what-if and create each appear once in the workflow",
    (wfText.match(/az deployment group what-if/g) ?? []).length === 1 && (wfText.match(/az deployment group create/g) ?? []).length === 1);
  check("staging: both Bicep commands use staging-app.bicep only",
    (wfText.match(/--template-file \S+/g) ?? []).every((m) => m === "--template-file infra/azure/hosting/staging-app.bicep") &&
    (wfText.match(/--template-file/g) ?? []).length === 2);
  check("staging: workflow never deploys main.bicep, production flags, complete mode or role assignments",
    !/main\.bicep|deployProductionApp|deployApps|--mode\s+Complete|az role|roleAssignments/i.test(wfText));
  check("staging: digest pinned from the pushed image (RepoDigests), not looked up by tag",
    wfText.includes("{{index .RepoDigests 0}}") && wfText.includes("cbc-web@sha256:[0-9a-f]{64}") &&
    !/az acr repository show/.test(wfText));
  check("staging: what-if, create, wait and config check all use the pinned image_ref",
    steps.filter((s) => /what-if|deployment group create|latestReadyRevisionName|staging-guard\.mjs config/.test(s))
      .every((s) => s.includes("steps.push.outputs.image_ref")) &&
    (wfText.match(/--parameters image=\S+/g) ?? []).length === 2 &&
    (wfText.match(/--parameters image=\S+/g) ?? []).every((m) => m === '--parameters image="$IMAGE_REF"'));
  check("staging: waits for the exact image, ready revision and /api/healthz",
    steps.some((s) => s.includes('[ \\"$image\\" = \\"$want\\" ]') && s.includes("/api/healthz")));
  check("staging: no automatic retry of provisioning", !/retry|continue-on-error/i.test(wfText));
  check("staging: checks the azure-staging app and registry names against main.parameters.json",
    steps.some((s) => s.includes(".parameters.stagingAppName.value") && s.includes(".parameters.registryName.value")));
}

// ---------------------------------------------------------------- staging-app.bicep (Gate 006C)
{
  const src = read("infra/azure/hosting/staging-app.bicep");
  noSecrets("staging-app.bicep", src);
  const code = src.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  check("staging-app.bicep: resource group scope", /^targetScope = 'resourceGroup'$/m.test(code));
  check("staging-app.bicep: only parameter is image", JSON.stringify([...code.matchAll(/^param (\w+)/gm)].map((m) => m[1])) === '["image"]');
  check("staging-app.bicep: values come from main.parameters.json",
    /^var cfg = loadJsonContent\('main\.parameters\.json'\)\.parameters$/m.test(code));
  const resources = [...code.matchAll(/^resource \w+ '([^']+)'(.*)$/gm)];
  check("staging-app.bicep: every resource is existing (creates nothing but the app module)",
    resources.length === 4 && resources.every((m) => m[2].includes(" existing = {")), resources.map((m) => m[1]).join(","));
  const modules = [...code.matchAll(/^module (\w+) '([^']+)'(.*)$/gm)];
  check("staging-app.bicep: exactly one module, web-app.bicep, unconditional, named web-staging",
    modules.length === 1 && modules[0][2] === "modules/web-app.bicep" && modules[0][3] === " = {" && /\n  name: 'web-staging'\n/.test(code));
  for (const [k, v] of [
    ["name", "cfg.stagingAppName.value"], ["secretNames", "cfg.stagingSecretNames.value"],
    ["plainEnv", "cfg.stagingPlainEnv.value"], ["injectWebRiskKey", "false"],
    ["minReplicas", "0"], ["maxReplicas", "1"], ["image", "image"],
  ]) check(`staging-app.bicep: passes ${k}: ${v}`, new RegExp(`^    ${k}: ${v.replace(/\./g, "\\.")}$`, "m").test(code));
  check("staging-app.bicep: no production value", !/production/i.test(code));
  const block = code.match(/\n  params: \{\n([\s\S]*?)\n  \}\n\}/)?.[1] ?? "";
  const passed = [...block.matchAll(/^ {4}(\w+):/gm)].map((m) => m[1]);
  const modParamList = [...read("infra/azure/hosting/modules/web-app.bicep").matchAll(/^param\s+(\w+)\s+\w+(\s*=)?/gm)]
    .map((m) => ({ name: m[1], required: !m[2] }));
  check("staging-app.bicep: passes every required web-app.bicep param and no unknown one",
    passed.length > 0 && modParamList.filter((p) => p.required).every((p) => passed.includes(p.name)) &&
    passed.every((p) => modParamList.some((q) => q.name === p)), passed.join(","));
}

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
// PR #32 review: an empty NEXT_PUBLIC_APP_URL must stay unset at build time, or Next
// inlines "" and `new URL(path, "")` in app/auth/callback/route.ts throws.
check("Dockerfile: NEXT_PUBLIC_APP_URL is never an ENV and is unset when empty",
  !/^\s*(ENV\s+)?NEXT_PUBLIC_APP_URL=/m.test(df.replace(/^#.*$/gm, "")) &&
  /else unset NEXT_PUBLIC_APP_URL; fi/.test(df));
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
// PR #32 review: in the container request.url is the bind address (0.0.0.0:3000), so
// absolute redirects must prefer NEXT_PUBLIC_APP_URL (Vercel previews leave it unset).
for (const f of ["app/auth/signout/route.ts", "app/auth/callback/route.ts"]) {
  const src = read(f);
  const redirects = [...src.matchAll(/new URL\(\s*[^,()]+,\s*([^)]+)\)/g)].map((m) => m[1].trim());
  check(`${f}: absolute redirects prefer NEXT_PUBLIC_APP_URL`,
    redirects.length > 0 && redirects.every((b) => b === "appUrl" || b.startsWith("process.env.NEXT_PUBLIC_APP_URL ??")) &&
    (!redirects.includes("appUrl") || /const appUrl = process\.env\.NEXT_PUBLIC_APP_URL \?\?/.test(src)),
    redirects.join(" | "));
}

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
  // Inngest derives its registered URL from the Host header and request protocol;
  // pin it so a sync from inside the container can never register an internal URL.
  const serveOrigin = ((pv(k) ?? []) as Array<{ name: string; value: string }>).find((e) => e.name === "INNGEST_SERVE_ORIGIN");
  check(`bicep params: ${k} pins INNGEST_SERVE_ORIGIN`, !!serveOrigin && /^(https:\/\/|REPLACE_WITH_)/.test(serveOrigin.value));
  const names = ((pv(k) ?? []) as Array<{ name: string }>).map((e) => e.name);
  check(`bicep params: ${k} holds no secret-named variables`,
    names.every((n: string) => !/(KEY|SECRET|PASSWORD|TOKEN)/.test(n)), names.join(","));
}
// Gate 006C P6 (founder-confirmed 2026-10-17): Phase B plain values are filled in.
{
  type PlainEnv = Array<{ name: string; value: string }>;
  const stgEnv = (pv("stagingPlainEnv") ?? []) as PlainEnv;
  const prodEnv = (pv("productionPlainEnv") ?? []) as PlainEnv;
  const val = (env: PlainEnv, n: string) => env.find((e) => e.name === n)?.value;
  check("P6: parameters file has no REPLACE_WITH_ placeholder left",
    !JSON.stringify(params).includes("REPLACE_WITH_"));
  check("P6: staging INNGEST_SERVE_ORIGIN is the Phase A staging origin (https, staging app, canadacentral)",
    /^https:\/\/ca-cbc-web-stg-cc-001\.[a-z0-9-]+\.canadacentral\.azurecontainerapps\.io$/.test(val(stgEnv, "INNGEST_SERVE_ORIGIN") ?? ""),
    val(stgEnv, "INNGEST_SERVE_ORIGIN"));
  check("P6: production INNGEST_SERVE_ORIGIN stays https://checkbeforeclick.com (production boundary unchanged)",
    val(prodEnv, "INNGEST_SERVE_ORIGIN") === "https://checkbeforeclick.com", val(prodEnv, "INNGEST_SERVE_ORIGIN"));
  check("P6: staging sets a non-empty INNGEST_ENV (Inngest branch environment)",
    /^[A-Za-z0-9._/-]+$/.test(val(stgEnv, "INNGEST_ENV") ?? ""), val(stgEnv, "INNGEST_ENV"));
  check("P6: production does not set INNGEST_ENV (defaults to the Inngest Production environment)",
    val(prodEnv, "INNGEST_ENV") === undefined);
  // Providers are enabled unless a flag is exactly "false" (lib/scan/providers/*.ts).
  // Staging reverses the earlier P6 "mirror Vercel" choice (founder requirement, Gate 006C
  // sprint 2026-10-24): its public URL runs master without the Gate 007A Web Risk budget,
  // so Web Risk stays off there until 007A is merged. Production still mirrors Vercel.
  check("P6: staging sets WEB_RISK_PROVIDER_ENABLED exactly \"false\" (no paid Web Risk calls before Gate 007A)",
    val(stgEnv, "WEB_RISK_PROVIDER_ENABLED") === "false", val(stgEnv, "WEB_RISK_PROVIDER_ENABLED"));
  check("P6: production does not set WEB_RISK_PROVIDER_ENABLED (mirrors Vercel Production)",
    val(prodEnv, "WEB_RISK_PROVIDER_ENABLED") === undefined, val(prodEnv, "WEB_RISK_PROVIDER_ENABLED"));
  for (const [k, env] of [["staging", stgEnv], ["production", prodEnv]] as const) {
    check(`P6: ${k} does not set DOMAIN_AGE_PROVIDER_ENABLED (provider enabled by default)`,
      !env.some((e) => e.name === "DOMAIN_AGE_PROVIDER_ENABLED"), env.map((e) => e.name).join(","));
  }
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
// Gate 006C decision P8: production minimum replicas is a parameter (0 before cutover,
// 1 when production is activated); staging stays at a fixed 0.
{
  const mainBicep = read(path.join(bicepDir, "main.bicep"));
  const moduleBlock = (name: string) =>
    mainBicep.match(new RegExp(`^module \\w+ 'modules/web-app\\.bicep'[^\\n]*\\n  name: '${name}'[\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
  const stg = moduleBlock("web-staging");
  const prod = moduleBlock("web-production");
  const decl = mainBicep.match(/((?:^@[^\n]*\n|^\s+\d+\n|^\]\)\n)*)^param productionMinReplicas (\w+)(.*)$/m);
  check("P8: productionMinReplicas is declared as int", decl?.[2] === "int", decl?.[0] ?? "missing");
  check("P8: productionMinReplicas has no default (omitting it fails the deployment)", decl !== null && decl[3].trim() === "");
  check("P8: productionMinReplicas is restricted to @allowed([0, 1])",
    /@allowed\(\[\s*0\s+1\s*\]\)\s*\nparam productionMinReplicas int/.test(mainBicep));
  check("P8: production module passes minReplicas: productionMinReplicas", /\n    minReplicas: productionMinReplicas\n/.test(prod));
  check("P8: production keeps maxReplicas 3", /\n    maxReplicas: 3\n/.test(prod));
  check("P8: staging module keeps minReplicas 0 and maxReplicas 1", /\n    minReplicas: 0\n/.test(stg) && /\n    maxReplicas: 1\n/.test(stg));
  check("P8: staging module does not use productionMinReplicas", stg !== "" && !stg.includes("productionMinReplicas"));
  check("P8: productionMinReplicas is used only by the production module",
    (mainBicep.match(/productionMinReplicas/g) ?? []).length === 2 && prod.includes("productionMinReplicas"));
  check("P8: no hardcoded production minReplicas remains", !/\n    minReplicas: 1\n/.test(mainBicep));
  const pmr = pv("productionMinReplicas");
  check("P8: parameters file sets productionMinReplicas to the pre-cutover value 0",
    Number.isInteger(pmr) && pmr === 0, JSON.stringify(pmr));
  const mod = read(path.join(bicepDir, "modules", "web-app.bicep"));
  check("P8: web-app.bicep bounds minReplicas to 0..1 (@minValue(0), @maxValue(1))",
    /@minValue\(0\)\n@maxValue\(1\)\nparam minReplicas int/.test(mod));
}
check("bicep: probes on /api/healthz port 3000", /path: '\/api\/healthz'/.test(bicep) && /targetPort: 3000/.test(bicep));
check("bicep: ingress https only", /allowInsecure: false/.test(bicep));
check("bicep: apps are Phase B only (deployApps, default false)",
  /param deployApps bool = false/.test(bicep) && /module staging '[^']+' = if \(deployApps\)/.test(bicep) &&
  /module production '[^']+' = if \(deployApps\)/.test(bicep));
check("bicep: no placeholder/bootstrap image that would fail the 3000 probe", !/quickstart/.test(bicep));

// ---------------------------------------------------------------- Bicep structure (Gate 006C offline validation)
// No Bicep compiler is available offline, so these checks catch the error classes a
// compile or deployment would: BCP138, parameter mismatches, and broken nesting.
// Single pass, so "//" inside a string (e.g. an https:// URL) is not taken as a comment.
// String contents become '' (interpolations are not inspected); comments are dropped.
function stripBicep(src: string): string {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
    } else if (ch === "'") {
      i++;
      while (i < src.length && src[i] !== "'") { if (src[i] === "\\") i++; i++; }
      out += "''";
    } else out += ch;
  }
  return out;
}
type BicepParam = { name: string; required: boolean };
const bicepParams = (src: string): BicepParam[] =>
  [...src.matchAll(/^param\s+(\w+)\s+\w+(\s*=)?/gm)].map((m) => ({ name: m[1], required: !m[2] }));
const mainSrc = read(path.join(bicepDir, "main.bicep"));
const modSrc = read(path.join(bicepDir, "modules", "web-app.bicep"));
for (const f of bicepFiles) {
  const code = stripBicep(read(f));
  // BCP138: a for-expression may not be a function argument, e.g. concat([for ...]).
  check(`${f}: no for-expression used as a function argument (BCP138)`, !/\w\(\s*\[\s*for\b/.test(code) && !/,\s*\[\s*for\b/.test(code));
  const depth = { "{": 0, "[": 0, "(": 0 } as Record<string, number>;
  const close: Record<string, string> = { "}": "{", "]": "[", ")": "(" };
  let negative = false;
  for (const ch of code) {
    if (ch in depth) depth[ch]++;
    else if (ch in close) { depth[close[ch]]--; if (depth[close[ch]] < 0) negative = true; }
  }
  check(`${f}: balanced braces, brackets and parentheses`, !negative && Object.values(depth).every((d) => d === 0), JSON.stringify(depth));
}
const mainParams = bicepParams(mainSrc);
const fileKeys = Object.keys(params.parameters);
check("bicep params file: every required main.bicep param is provided",
  mainParams.filter((p) => p.required).every((p) => fileKeys.includes(p.name)),
  mainParams.filter((p) => p.required && !fileKeys.includes(p.name)).map((p) => p.name).join(","));
check("bicep params file: no key that main.bicep does not declare (ARM rejects unknown parameters)",
  fileKeys.every((k) => mainParams.some((p) => p.name === k)),
  fileKeys.filter((k) => !mainParams.some((p) => p.name === k)).join(","));
const modParams = bicepParams(modSrc);
// One check per expected module, so a block that cannot be parsed fails instead of
// silently producing no check at all.
const moduleParamBlocks = new Map(
  [...mainSrc.matchAll(/^module\s+(\w+)\s+'modules\/web-app\.bicep'[\s\S]*?\n  params: \{\n([\s\S]*?)\n  \}\n\}/gm)]
    .map((m) => [m[1], m[2]] as const));
for (const name of ["staging", "production"]) {
  const block = moduleParamBlocks.get(name);
  const passed = block === undefined ? [] : [...block.matchAll(/^\s{4}(\w+):/gm)].map((x) => x[1]);
  check(`bicep module ${name}: passes every required web-app.bicep param and no unknown one`,
    block !== undefined &&
    modParams.filter((p) => p.required).every((p) => passed.includes(p.name)) &&
    passed.every((p) => modParams.some((q) => q.name === p)),
    block === undefined ? "params block not found or not parseable" : `passed=${passed.join(",")}`);
}
check("bicep: every web-app module declaration has a parseable params block",
  moduleParamBlocks.size === (mainSrc.match(/^module\s+\w+\s+'modules\/web-app\.bicep'/gm) ?? []).length,
  `parsed=${[...moduleParamBlocks.keys()].join(",")}`);
check("bicep: both web-app modules are invoked", (mainSrc.match(/^module\s+\w+\s+'modules\/web-app\.bicep'/gm) ?? []).length === 2);
const vaultKeys = [...modSrc.matchAll(/vaultKey:\s*'(\w+)'/g)].map((m) => m[1]).sort();
for (const k of ["stagingSecretNames", "productionSecretNames"]) {
  check(`bicep params: ${k} keys match web-app.bicep secretMap vaultKeys`,
    JSON.stringify(Object.keys(pv(k) ?? {}).sort()) === JSON.stringify(vaultKeys), Object.keys(pv(k) ?? {}).join(","));
}
const usedSymbols = new Set([...stripBicep(mainSrc).matchAll(/\b(\w+)\.(?:id|properties|name|outputs|listKeys)\b/g)].map((m) => m[1]));
const declared = new Set([...mainSrc.matchAll(/^(?:resource|module)\s+(\w+)\s/gm)].map((m) => m[1]));
check("bicep main: every symbol used with .id/.properties/.outputs is a declared resource or module",
  [...usedSymbols].filter((s) => s !== "s").every((s) => declared.has(s)),
  [...usedSymbols].filter((s) => !declared.has(s)).join(","));

// Gate 006C (founder requirement 2026-10-24): staging never receives the Web Risk key, so it
// cannot make a paid Web Risk request even if WEB_RISK_PROVIDER_ENABLED is missing or wrong
// (googleWebRisk.ts returns early without the key). The switch is fixed in main.bicep, not in
// the parameters file. Production keeps the key.
check("Web Risk key: secretMap maps googleWebRiskApiKey to GOOGLE_WEB_RISK_API_KEY (the entry the filter removes)",
  /^  \{ name: 'google-web-risk-api-key', vaultKey: 'googleWebRiskApiKey', envName: 'GOOGLE_WEB_RISK_API_KEY' \}$/m.test(modSrc));
check("Web Risk key: web-app.bicep declares a required bool injectWebRiskKey (no default)",
  /^param injectWebRiskKey bool\s*$/m.test(modSrc));
check("Web Risk key: web-app.bicep drops googleWebRiskApiKey from secretMap unless injectWebRiskKey",
  /^var activeSecrets = filter\(secretMap, s => injectWebRiskKey \|\| s\.vaultKey != 'googleWebRiskApiKey'\)$/m.test(modSrc));
{
  const code = stripBicep(modSrc);
  check("Web Risk key: secretMap is used only in its declaration and the filter",
    (code.match(/\bsecretMap\b/g) ?? []).length === 2);
  check("Web Risk key: both the Container Apps secrets and the env loop over activeSecrets",
    (code.match(/\[for s in activeSecrets:/g) ?? []).length === 2 && !/\[for s in secretMap\b/.test(code));
}
for (const [name, want] of [["staging", "false"], ["production", "true"]] as const) {
  const got = moduleParamBlocks.get(name)?.match(/^ {4}injectWebRiskKey:\s*(\w+)\s*$/m)?.[1];
  check(`Web Risk key: ${name} module passes injectWebRiskKey: ${want} literally`, got === want, String(got));
}
check("Web Risk key: main.bicep has no injectWebRiskKey parameter (cannot be flipped from the parameters file)",
  !mainParams.some((p) => p.name === "injectWebRiskKey") && !("injectWebRiskKey" in params.parameters));
for (const k of ["stagingPlainEnv", "productionPlainEnv"]) {
  check(`Web Risk key: ${k} does not set GOOGLE_WEB_RISK_API_KEY`,
    !((pv(k) ?? []) as Array<{ name: string }>).some((e) => e.name === "GOOGLE_WEB_RISK_API_KEY"));
}

// ---------------------------------------------------------------- no stray workflows deploy
for (const f of readdirSync(path.join(ROOT, ".github", "workflows"))) {
  if (f === "azure-deploy.yml") continue;
  const t = read(path.join(".github", "workflows", f));
  check(`${f}: does not call Azure`, !/azure\/login|az containerapp|az acr/.test(t));
}

// ---------------------------------------------------------------- staging-guard.mjs behaviour
// Synthetic what-if and `az containerapp show` documents (no Azure). Each broken
// variant must be rejected; the good ones must pass.
{
  type Guard = {
    checkWhatIf: (r: unknown, app: string, image: string) => { problems: string[] };
    checkConfig: (a: unknown, image: string) => { problems: string[] };
  };
  const guard = (await import(pathToFileURL(path.join(ROOT, "scripts/azure-hosting/staging-guard.mjs")).href)) as Guard;
  const APP = "ca-cbc-web-stg-cc-001";
  const IMG = `crcbcprodcc001.azurecr.io/cbc-web@sha256:${"a".repeat(64)}`;
  const RG = "/subscriptions/0/resourceGroups/rg-cbc-prod-canadacentral-001/providers";
  const props = () => ({
    configuration: { secrets: [
      { name: "supabase-service-role-key", keyVaultUrl: "https://kv/secrets/cbc-stg-supabase-service-role-key" },
      { name: "inngest-event-key", keyVaultUrl: "https://kv/secrets/cbc-stg-inngest-event-key" },
    ] },
    template: {
      containers: [{ image: IMG, env: [
        { name: "SUPABASE_SERVICE_ROLE_KEY", secretRef: "supabase-service-role-key" },
        { name: "WEB_RISK_PROVIDER_ENABLED", value: "false" },
      ] }],
      scale: { minReplicas: 0, maxReplicas: 1 },
    },
  });
  type Props = ReturnType<typeof props>;
  const whatIf = (p: Props, extra: unknown[] = [], changeType = "Create") => ({
    status: "Succeeded",
    changes: [{ changeType, resourceId: `${RG}/Microsoft.App/containerApps/${APP}`, after: { properties: p } }, ...extra],
  });
  const mutate = (f: (p: Props) => void) => { const p = props(); f(p); return p; };
  const webRiskSecret = (p: Props) => p.configuration.secrets.push({ name: "google-web-risk-api-key", keyVaultUrl: "https://kv/secrets/cbc-shared-google-web-risk-api-key" });
  const webRiskEnv = (p: Props) => p.template.containers[0].env.push({ name: "GOOGLE_WEB_RISK_API_KEY", secretRef: "x" });
  const ok = (r: { problems: string[] }) => r.problems.length === 0;

  check("guard whatif: first-time Create of the staging app passes", ok(guard.checkWhatIf(whatIf(props()), APP, IMG)));
  check("guard whatif: Modify of the staging app with Ignore elsewhere passes",
    ok(guard.checkWhatIf(whatIf(props(), [{ changeType: "Ignore", resourceId: `${RG}/Microsoft.App/containerApps/ca-cbc-web-prod-cc-001` }], "Modify"), APP, IMG)));
  for (const [name, doc] of [
    ["Web Risk secret", whatIf(mutate(webRiskSecret))],
    ["GOOGLE_WEB_RISK_API_KEY env", whatIf(mutate(webRiskEnv))],
    ["provider flag missing", whatIf(mutate((p) => { p.template.containers[0].env = p.template.containers[0].env.filter((e) => e.name !== "WEB_RISK_PROVIDER_ENABLED"); }))],
    ["provider flag \"False\"", whatIf(mutate((p) => { p.template.containers[0].env[1].value = "False"; }))],
    ["maxReplicas 2", whatIf(mutate((p) => { p.template.scale.maxReplicas = 2; }))],
    ["minReplicas 1", whatIf(mutate((p) => { p.template.scale.minReplicas = 1; }))],
    ["other image", whatIf(mutate((p) => { p.template.containers[0].image = IMG.replace("@sha256:a", "@sha256:b"); }))],
    ["Create of another resource", whatIf(props(), [{ changeType: "Create", resourceId: `${RG}/Microsoft.App/containerApps/ca-cbc-web-prod-cc-001` }])],
    ["Modify of another resource", whatIf(props(), [{ changeType: "Modify", resourceId: `${RG}/Microsoft.KeyVault/vaults/kv-cbc-prod-cc-001` }])],
    ["Delete of the staging app", whatIf(props(), [], "Delete")],
    ["status Failed", { ...whatIf(props()), status: "Failed" }],
    ["no change for the staging app", { status: "Succeeded", changes: [] }],
  ] as const) check(`guard whatif: rejects ${name}`, !ok(guard.checkWhatIf(doc, APP, IMG)));

  const app = (p: Props) => ({ name: APP, properties: p });
  check("guard config: compliant staging app passes", ok(guard.checkConfig(app(props()), IMG)));
  for (const [name, p] of [
    ["Web Risk secret", mutate(webRiskSecret)],
    ["GOOGLE_WEB_RISK_API_KEY env", mutate(webRiskEnv)],
    ["provider flag missing", mutate((p) => { p.template.containers[0].env.pop(); })],
    ["maxReplicas 2", mutate((p) => { p.template.scale.maxReplicas = 2; })],
    ["other image", mutate((p) => { p.template.containers[0].image = "crcbcprodcc001.azurecr.io/cbc-web:latest"; })],
  ] as const) check(`guard config: rejects ${name}`, !ok(guard.checkConfig(app(p), IMG)));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
