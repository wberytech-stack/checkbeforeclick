// Gate 006C - fail-closed checks for the single-dispatch staging deployment (azure-deploy.yml).
//
//   node scripts/azure-hosting/staging-guard.mjs whatif <what-if.json> <app name> <image ref>
//   node scripts/azure-hosting/staging-guard.mjs config <containerapp-show.json> <image ref>
//
// "whatif" reads `az deployment group what-if --no-pretty-print --output json`;
// "config" reads `az containerapp show --output json`. Both print only resource ids,
// change types, setting names and a verdict, never values, and exit 1 on any problem.
// Plain JavaScript with no dependencies, so it runs on the runner's own Node.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const WEB_RISK = /web-?risk/i;
const ALLOWED_ELSEWHERE = new Set(["NoChange", "Ignore"]);

// Problems in the app definition shared by both checks: properties as in ARM.
function appProblems(props, image) {
  const problems = [];
  const secrets = props?.configuration?.secrets ?? [];
  const containers = props?.template?.containers ?? [];
  const env = containers.flatMap((c) => c.env ?? []);
  const scale = props?.template?.scale ?? {};
  if (secrets.some((s) => WEB_RISK.test(s.name ?? "") || WEB_RISK.test(s.keyVaultUrl ?? "")))
    problems.push("staging has a Web Risk secret or Key Vault reference");
  if (env.some((e) => e.name === "GOOGLE_WEB_RISK_API_KEY" || WEB_RISK.test(e.secretRef ?? "")))
    problems.push("staging has a GOOGLE_WEB_RISK_API_KEY environment variable");
  if (env.find((e) => e.name === "WEB_RISK_PROVIDER_ENABLED")?.value !== "false")
    problems.push('WEB_RISK_PROVIDER_ENABLED is not exactly "false"');
  if (scale.minReplicas !== 0 || scale.maxReplicas !== 1)
    problems.push(`scale is min ${scale.minReplicas} / max ${scale.maxReplicas}, expected 0 / 1`);
  if (containers.length !== 1 || containers[0].image !== image)
    problems.push("container image is not the image pushed by this run");
  return problems;
}

export function checkWhatIf(result, appName, image) {
  const problems = [];
  if (result?.status !== "Succeeded") problems.push(`what-if status is ${result?.status ?? "missing"}`);
  if (result?.error) problems.push("what-if returned an error");
  const changes = result?.changes ?? [];
  const isApp = (c) => typeof c.resourceId === "string" &&
    c.resourceId.toLowerCase().endsWith(`/providers/microsoft.app/containerapps/${appName}`.toLowerCase());
  const app = changes.filter(isApp);
  for (const c of changes.filter((c) => !isApp(c))) {
    if (!ALLOWED_ELSEWHERE.has(c.changeType)) problems.push(`unexpected ${c.changeType} on ${c.resourceId}`);
  }
  if (app.length !== 1) problems.push(`expected exactly one change for ${appName}, found ${app.length}`);
  else if (!["Create", "Modify", "NoChange"].includes(app[0].changeType)) problems.push(`${appName}: ${app[0].changeType} is not allowed`);
  else problems.push(...appProblems(app[0].after?.properties, image));
  return { problems, summary: changes.map((c) => `${c.changeType} ${c.resourceId}`) };
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
