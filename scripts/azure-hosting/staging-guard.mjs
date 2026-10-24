// Gate 006C - fail-closed checks for the single-dispatch staging deployment (azure-deploy.yml).
//
//   node scripts/azure-hosting/staging-guard.mjs whatif <what-if.json> <app name> <image ref>
//   node scripts/azure-hosting/staging-guard.mjs config <containerapp-show.json> <image ref>
//
// "whatif" reads `az deployment group what-if --no-pretty-print --output json`;
// "config" reads `az containerapp show --output json`. Both print only resource ids,
// change types, setting names and a verdict, never values, and exit 1 on any problem.
// Plain JavaScript with no dependencies, so it runs on the runner's own Node.
//
// What-if JSON shape (Azure CLI 2.x, azure-mgmt-resource WhatIfOperationResult as
// serialized by the CLI): { status, error, changes[], potentialChanges[], diagnostics[] };
// each change { resourceId, changeType, unsupportedReason, before, after, delta }.
// Microsoft documents that what-if may short-circuit modules (reported in diagnostics)
// and shows unevaluated expressions as-is, so anything not concrete is rejected.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The only Key Vault-backed settings staging may have (web-app.bicep secretMap minus Web Risk).
const ALLOWED_SECRETS = new Map([
  ["supabase-service-role-key", "SUPABASE_SERVICE_ROLE_KEY"],
  ["inngest-event-key", "INNGEST_EVENT_KEY"],
  ["inngest-signing-key", "INNGEST_SIGNING_KEY"],
]);
const WEB_RISK_KEY = /google[-_]?web[-_]?risk/i;
const ALLOWED_ELSEWHERE = new Set(["NoChange", "Ignore"]);
const isExpression = (v) => typeof v === "string" && v.startsWith("[") && v.endsWith("]");
const isConcrete = (v) => typeof v === "string" && v !== "" && !isExpression(v);

// Problems in the app definition shared by both checks: properties as in ARM.
function appProblems(props, image) {
  if (!props || typeof props !== "object") return ["app definition is missing"];
  const problems = [];
  if (WEB_RISK_KEY.test(JSON.stringify(props))) problems.push("app definition mentions the Google Web Risk key");
  const secrets = props.configuration?.secrets ?? [];
  const containers = props.template?.containers ?? [];
  const env = containers.flatMap((c) => c.env ?? []);
  const scale = props.template?.scale ?? {};
  for (const s of secrets) {
    if (!isConcrete(s.name) || !ALLOWED_SECRETS.has(s.name)) problems.push("a secret is not on the staging allowlist or is not concrete");
    else if (!isConcrete(s.keyVaultUrl ?? "") || !/^https:\/\//.test(s.keyVaultUrl)) problems.push(`secret ${s.name}: Key Vault URL is not concrete`);
  }
  for (const e of env) {
    if (!isConcrete(e.name)) problems.push("an environment variable name is not concrete");
    else if (e.secretRef !== undefined && e.secretRef !== null && ALLOWED_SECRETS.get(e.secretRef) !== e.name)
      problems.push(`${e.name}: secret reference is not on the staging allowlist`);
  }
  if (env.find((e) => e.name === "WEB_RISK_PROVIDER_ENABLED")?.value !== "false")
    problems.push('WEB_RISK_PROVIDER_ENABLED is not exactly "false"');
  if (scale.minReplicas !== 0 || scale.maxReplicas !== 1)
    problems.push(`scale is min ${scale.minReplicas} / max ${scale.maxReplicas}, expected 0 / 1`);
  if (containers.length !== 1 || containers[0].image !== image)
    problems.push("container image is not the image pushed by this run");
  if ((props.template?.initContainers ?? []).length > 0) problems.push("staging must not have init containers");
  return problems;
}

export function checkWhatIf(result, appName, image) {
  const problems = [];
  if (result?.status !== "Succeeded") problems.push(`what-if status is ${result?.status ?? "missing"}`);
  if (result?.error) problems.push("what-if returned an error");
  if ((result?.potentialChanges ?? []).length > 0) problems.push("what-if reported potential changes it could not evaluate");
  for (const d of result?.diagnostics ?? []) {
    if (String(d?.level ?? "").toLowerCase() !== "info") problems.push(`what-if diagnostic ${d?.level ?? "?"} ${d?.code ?? ""}`.trim());
  }
  const changes = result?.changes ?? [];
  const isApp = (c) => typeof c.resourceId === "string" &&
    c.resourceId.toLowerCase().endsWith(`/providers/microsoft.app/containerapps/${appName}`.toLowerCase());
  const app = changes.filter(isApp);
  for (const c of changes.filter((c) => !isApp(c))) {
    if (!ALLOWED_ELSEWHERE.has(c.changeType)) problems.push(`unexpected ${c.changeType} on ${c.resourceId ?? "a resource without an id"}`);
  }
  if (app.length !== 1) problems.push(`expected exactly one change for ${appName}, found ${app.length}`);
  else if (!["Create", "Modify", "NoChange"].includes(app[0].changeType)) problems.push(`${appName}: ${app[0].changeType} is not allowed`);
  else problems.push(...appProblems(app[0].after?.properties, image));
  return { problems, summary: changes.map((c) => `${c.changeType} ${c.resourceId ?? "(no id)"}`) };
}

export function checkConfig(app, image) {
  return { problems: appProblems(app?.properties, image), summary: [`checked ${app?.name ?? "unknown app"}`] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file, ...rest] = process.argv.slice(2);
  const json = JSON.parse(readFileSync(file, "utf8"));
  const { problems, summary } =
    mode === "whatif" ? checkWhatIf(json, rest[0], rest[1]) :
    mode === "config" ? checkConfig(json, rest[0]) :
    { problems: [`unknown mode ${mode}`], summary: [] };
  for (const line of summary) console.log(line);
  for (const p of problems) console.log(`::error::${p}`);
  console.log(problems.length === 0 ? "staging guard: PASS" : `staging guard: FAIL (${problems.length})`);
  process.exit(problems.length === 0 ? 0 : 1);
}
