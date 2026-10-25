// Gate 006C - fail-closed checks for the single-dispatch staging deployment (azure-deploy.yml).
//
//   node scripts/azure-hosting/staging-guard.mjs template <compiled staging-app.json> <app name> <image ref>
//   node scripts/azure-hosting/staging-guard.mjs whatif <what-if.json> <app name> <image ref>
//   node scripts/azure-hosting/staging-guard.mjs config <containerapp-show.json> <image ref>
//
// "template" reads the ARM JSON compiled from staging-app.bicep, the exact file the
// workflow then passes to what-if and to the deployment. "whatif" reads
// `az deployment group what-if --no-pretty-print --output json`; "config" reads
// `az containerapp show --output json`. All print only resource ids, change types,
// setting names and a verdict, never values, and exit 1 on any problem.
// Plain JavaScript with no dependencies, so it runs on the runner's own Node.
//
// What-if JSON shape (Azure CLI 2.x, azure-mgmt-resource WhatIfOperationResult as
// serialized by the CLI): { status, error, changes[], potentialChanges[], diagnostics[] };
// each change { resourceId, changeType, unsupportedReason, before, after, delta }.
// Microsoft documents that what-if may short-circuit modules (reported in diagnostics)
// and shows unevaluated expressions as-is, so anything not concrete is rejected.
//
// Azure what-if masks Container App secret names, and the env secretRef that point at
// them, as the literal "*******" (observed on the first staging run, 2026-10-24). The
// names are therefore proven by the "template" check, which resolves them from the
// compiled template's literal inputs; what-if accepts the mask only at the three
// approved positions, each pinned by its concrete Key Vault URL and env variable name.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The only Key Vault-backed settings staging may have, in secretMap order (web-app.bicep
// secretMap minus Web Risk), with the staging Key Vault secret each one must reference.
const APPROVED = [
  { name: "supabase-service-role-key", vaultKey: "supabaseServiceRoleKey", envName: "SUPABASE_SERVICE_ROLE_KEY", kvSecret: "cbc-stg-supabase-service-role-key" },
  { name: "inngest-event-key", vaultKey: "inngestEventKey", envName: "INNGEST_EVENT_KEY", kvSecret: "cbc-stg-inngest-event-key" },
  { name: "inngest-signing-key", vaultKey: "inngestSigningKey", envName: "INNGEST_SIGNING_KEY", kvSecret: "cbc-stg-inngest-signing-key" },
];
const KEY_VAULT_URI = "https://kv-cbc-prod-cc-001.vault.azure.net/";
const RUNTIME_IDENTITY = "/providers/microsoft.managedidentity/userassignedidentities/id-cbc-web-cc-001";
const IMAGE_REF = /^crcbcprodcc001\.azurecr\.io\/cbc-web@sha256:[0-9a-f]{64}$/;
// Inngest staging isolation (Gate 006C P6): the branch environment and the staging origin.
const STAGING_INNGEST_ENV = "audit/azure-current-state";
const STAGING_ORIGIN = /^https:\/\/ca-cbc-web-stg-cc-001\.[a-z0-9-]+\.canadacentral\.azurecontainerapps\.io$/;
function inngestProblems(env, fqdn) {
  const problems = [];
  const values = (n) => env.filter((e) => e?.name === n).map((e) => e.value);
  if (values("INNGEST_ENV").join("\n") !== STAGING_INNGEST_ENV) problems.push(`INNGEST_ENV is not exactly once "${STAGING_INNGEST_ENV}"`);
  const origin = values("INNGEST_SERVE_ORIGIN");
  if (origin.length !== 1 || !STAGING_ORIGIN.test(origin[0] ?? "")) problems.push("INNGEST_SERVE_ORIGIN is not exactly once the staging Container App origin");
  else if (fqdn && origin[0] !== `https://${fqdn}`) problems.push("INNGEST_SERVE_ORIGIN does not match the app's ingress FQDN");
  return problems;
}
const WHAT_IF_MASK = "*******";
const WEB_RISK_KEY = /google[-_]?web[-_]?risk/i;
const ALLOWED_ELSEWHERE = new Set(["NoChange", "Ignore"]);

// Canonical JSON with sorted keys, for exact structural comparison.
const canon = (v) => JSON.stringify(v, (_k, x) =>
  x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x);
const same = (a, b) => canon(a) === canon(b);
const keysAre = (o, keys) => !!o && typeof o === "object" && !Array.isArray(o) && same(Object.keys(o).sort(), [...keys].sort());

// Secret entries and the env entries that reference them. In what-if the names may be
// the mask, but only position by position, with the concrete Key Vault URL and env
// name of that same position matching the approved entry exactly.
function secretProblems(props, { whatIf }) {
  const problems = [];
  const secrets = props.configuration?.secrets;
  const containers = props.template?.containers ?? [];
  const env = containers.length === 1 && Array.isArray(containers[0].env) ? containers[0].env : [];
  if (!Array.isArray(secrets) || secrets.length !== APPROVED.length) {
    return [`expected exactly ${APPROVED.length} secrets, found ${Array.isArray(secrets) ? secrets.length : "none"}`];
  }
  const nameOk = (v, want) => v === want || (whatIf && v === WHAT_IF_MASK);
  const urlFor = (a) => `${KEY_VAULT_URI}secrets/${a.kvSecret}`;
  const identityOk = (v) => typeof v === "string" && v.toLowerCase().endsWith(RUNTIME_IDENTITY);
  if (whatIf) {
    APPROVED.forEach((a, i) => {
      const s = secrets[i];
      if (!keysAre(s, ["name", "keyVaultUrl", "identity"])) { problems.push(`secret ${i}: unexpected structure`); return; }
      if (!nameOk(s.name, a.name)) problems.push(`secret ${i}: name is neither ${a.name} nor the what-if mask`);
      if (s.keyVaultUrl !== urlFor(a)) problems.push(`secret ${i}: Key Vault URL is not the approved ${a.kvSecret}`);
      if (!identityOk(s.identity)) problems.push(`secret ${i}: not read through the runtime identity`);
    });
  } else {
    // The live app returns concrete names; match them as a set.
    for (const s of secrets) {
      const a = APPROVED.find((x) => x.name === s?.name);
      const extra = s && typeof s === "object" ? Object.keys(s).filter((k) => !["name", "keyVaultUrl", "identity", "value"].includes(k)) : ["?"];
      if (!a) { problems.push("a secret is not on the staging allowlist or is not concrete"); continue; }
      if (extra.length > 0 || (s.value !== undefined && s.value !== null)) problems.push(`secret ${a.name}: unexpected structure`);
      if (s.keyVaultUrl !== urlFor(a)) problems.push(`secret ${a.name}: Key Vault URL is not the approved ${a.kvSecret}`);
      if (!identityOk(s.identity)) problems.push(`secret ${a.name}: not read through the runtime identity`);
    }
    if (new Set(secrets.map((s) => s?.name)).size !== secrets.length) problems.push("duplicate secret names");
  }
  const withRef = env.filter((e) => e && typeof e === "object" && "secretRef" in e);
  if (withRef.length !== APPROVED.length) problems.push(`expected exactly ${APPROVED.length} secret-backed env variables, found ${withRef.length}`);
  if (whatIf) {
    APPROVED.forEach((a, i) => {
      const e = env[i];
      if (!keysAre(e, ["name", "secretRef"])) { problems.push(`env ${i}: unexpected structure`); return; }
      if (e.name !== a.envName) problems.push(`env ${i}: name is not ${a.envName}`);
      if (!nameOk(e.secretRef, a.name)) problems.push(`${a.envName}: secretRef is neither ${a.name} nor the what-if mask`);
    });
  } else {
    for (const e of withRef) {
      const a = APPROVED.find((x) => x.envName === e.name);
      if (!a || e.secretRef !== a.name || (e.value !== undefined && e.value !== null)) problems.push(`${e.name}: secret reference is not on the staging allowlist`);
    }
  }
  if (env.some((e) => typeof e?.name !== "string" || e.name === "" || e.name.startsWith("["))) problems.push("an environment variable name is not concrete");
  if (new Set(env.map((e) => e?.name)).size !== env.length) problems.push("duplicate environment variable names");
  return problems;
}

// Problems in the app definition shared by what-if and config: properties as in ARM.
function appProblems(props, image, { whatIf }) {
  if (!props || typeof props !== "object") return ["app definition is missing"];
  const problems = [];
  if (WEB_RISK_KEY.test(JSON.stringify(props))) problems.push("app definition mentions the Google Web Risk key");
  problems.push(...secretProblems(props, { whatIf }));
  const containers = props.template?.containers ?? [];
  const env = containers.flatMap((c) => c.env ?? []);
  const scale = props.template?.scale ?? {};
  problems.push(...inngestProblems(env, whatIf ? null : props.configuration?.ingress?.fqdn));
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
  else problems.push(...appProblems(app[0].after?.properties, image, { whatIf: true }));
  return { problems, summary: changes.map((c) => `${c.changeType} ${c.resourceId ?? "(no id)"}`) };
}

export function checkConfig(app, image) {
  return { problems: appProblems(app?.properties, image, { whatIf: false }), summary: [`checked ${app?.name ?? "unknown app"}`] };
}

// ---------------------------------------------------------------- compiled template
// The reviewed compiled form of staging-app.bicep and modules/web-app.bicep (Bicep CLI
// pinned in azure-deploy.yml). Every security-relevant node must match exactly; the
// secret names are then resolved from the literal inputs (secretMap, the literal
// injectWebRiskKey, the embedded main.parameters.json) with the same filter semantics.
const EXPECTED_MODULE_PARAMS = {
  name: { value: "[variables('cfg').stagingAppName.value]" },
  location: { value: "[resourceGroup().location]" },
  environmentId: { value: "[resourceId('Microsoft.App/managedEnvironments', variables('cfg').environmentName.value)]" },
  identityId: { value: "[resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', variables('cfg').identityName.value)]" },
  registryServer: { value: "[format('{0}{1}', variables('cfg').registryName.value, environment().suffixes.acrLoginServer)]" },
  image: { value: "[parameters('image')]" },
  keyVaultUri: { value: "[format('https://{0}{1}/', variables('cfg').keyVaultName.value, environment().suffixes.keyvaultDns)]" },
  secretNames: { value: "[variables('cfg').stagingSecretNames.value]" },
  plainEnv: { value: "[variables('cfg').stagingPlainEnv.value]" },
  injectWebRiskKey: { value: false },
  minReplicas: { value: 0 },
  maxReplicas: { value: 1 },
  tags: { value: { project: "checkbeforeclick", gate: "006B", environment: "staging" } },
};
const SECRET_MAP = [
  { name: "supabase-service-role-key", vaultKey: "supabaseServiceRoleKey", envName: "SUPABASE_SERVICE_ROLE_KEY" },
  { name: "google-web-risk-api-key", vaultKey: "googleWebRiskApiKey", envName: "GOOGLE_WEB_RISK_API_KEY" },
  { name: "inngest-event-key", vaultKey: "inngestEventKey", envName: "INNGEST_EVENT_KEY" },
  { name: "inngest-signing-key", vaultKey: "inngestSigningKey", envName: "INNGEST_SIGNING_KEY" },
];
const EXPECTED_INNER_VARIABLES = {
  copy: [{
    name: "secretEnv",
    count: "[length(variables('activeSecrets'))]",
    input: {
      name: "[variables('activeSecrets')[copyIndex('secretEnv')].envName]",
      secretRef: "[variables('activeSecrets')[copyIndex('secretEnv')].name]",
    },
  }],
  secretMap: SECRET_MAP,
  activeSecrets: "[filter(variables('secretMap'), lambda('s', or(parameters('injectWebRiskKey'), not(equals(lambdaVariables('s').vaultKey, 'googleWebRiskApiKey')))))]",
  activePlainEnv: "[filter(parameters('plainEnv'), lambda('e', or(parameters('injectWebRiskKey'), not(equals(lambdaVariables('e').name, 'GOOGLE_WEB_RISK_API_KEY')))))]",
};
const EXPECTED_SECRETS_COPY = [{
  name: "secrets",
  count: "[length(variables('activeSecrets'))]",
  input: {
    name: "[variables('activeSecrets')[copyIndex('secrets')].name]",
    keyVaultUrl: "[format('{0}secrets/{1}', parameters('keyVaultUri'), parameters('secretNames')[variables('activeSecrets')[copyIndex('secrets')].vaultKey])]",
    identity: "[parameters('identityId')]",
  },
}];
const EXPECTED_APP_IDENTITY = { type: "UserAssigned", userAssignedIdentities: { "[format('{0}', parameters('identityId'))]": {} } };
const EXPECTED_INGRESS = { external: true, targetPort: 3000, transport: "auto", allowInsecure: false };
const EXPECTED_REGISTRIES = [{ server: "[parameters('registryServer')]", identity: "[parameters('identityId')]" }];
const EXPECTED_ENV ="[concat(variables('secretEnv'), createArray(createObject('name', 'PORT', 'value', '3000'), createObject('name', 'HOSTNAME', 'value', '0.0.0.0')), variables('activePlainEnv'))]";

export function checkTemplate(t, appName, image) {
  const problems = [];
  const fail = (p) => { problems.push(p); return { problems, summary: [] }; };
  if (!IMAGE_REF.test(String(image))) problems.push("image input is not crcbcprodcc001.azurecr.io/cbc-web@sha256:<64 hex>");
  if (!keysAre(t?.parameters, ["image"]) || t.parameters.image?.type !== "string") problems.push("template parameters must be exactly { image: string }");
  if (!keysAre(t?.variables, ["$fxv#0", "cfg"]) || t.variables.cfg !== "[variables('$fxv#0').parameters]")
    return fail("template variables are not the reviewed loadJsonContent form");
  const cfg = t.variables["$fxv#0"]?.parameters;
  if (!cfg || typeof cfg !== "object") return fail("embedded main.parameters.json is missing");
  const val = (k) => cfg[k]?.value;
  if (!Array.isArray(t.resources) || t.resources.length !== 1) return fail("template must deploy exactly one resource");
  const m = t.resources[0];
  if (m.type !== "Microsoft.Resources/deployments" || m.name !== "web-staging" || "condition" in m) problems.push("the only resource must be the unconditional web-staging module");
  if (m.properties?.mode !== "Incremental" || m.properties?.expressionEvaluationOptions?.scope !== "inner") problems.push("module must be Incremental with inner scope");
  if (!same(m.properties?.parameters, EXPECTED_MODULE_PARAMS)) problems.push("module parameters differ from the reviewed staging values");
  const inner = m.properties?.template;
  if (!same(inner?.variables, EXPECTED_INNER_VARIABLES)) return fail("module variables (secretMap, filters, secret env loop) differ from the reviewed form");
  if (!Array.isArray(inner?.resources) || inner.resources.length !== 1) return fail("module must deploy exactly one resource");
  const app = inner.resources[0];
  if (app.type !== "Microsoft.App/containerApps" || app.name !== "[parameters('name')]") problems.push("module resource must be the Container App");
  // Runtime identity, registry pull and ingress, bound to the module parameters pinned in
  // EXPECTED_MODULE_PARAMS (identityId, registryServer) and the names checked below.
  if (!same(app.identity, EXPECTED_APP_IDENTITY)) problems.push("Container App identity is not the user-assigned runtime identity binding");
  if (!keysAre(app.properties, ["managedEnvironmentId", "configuration", "template"])) problems.push("Container App properties are not the reviewed set");
  const conf = app.properties?.configuration ?? {};
  if (!keysAre(conf, ["copy", "activeRevisionsMode", "ingress", "registries"]) || conf.activeRevisionsMode !== "Single")
    problems.push("Container App configuration is not the reviewed set");
  if (!same(conf.ingress, EXPECTED_INGRESS)) problems.push("ingress is not external HTTPS-only on port 3000");
  if (!same(conf.registries, EXPECTED_REGISTRIES)) problems.push("registry is not the reviewed server pulled by the runtime identity");
  if ("secrets" in conf || !same(conf.copy, EXPECTED_SECRETS_COPY)) problems.push("Container App secrets are not the reviewed secrets loop");
  const tpl = app.properties?.template ?? {};
  if (!keysAre(tpl, ["containers", "scale"])) problems.push("Container App template must contain only containers and scale");
  if (!same(tpl.scale, { minReplicas: "[parameters('minReplicas')]", maxReplicas: "[parameters('maxReplicas')]" })) problems.push("scale is not bound to the module parameters");
  if (!Array.isArray(tpl.containers) || tpl.containers.length !== 1 || tpl.containers[0].image !== "[parameters('image')]" || tpl.containers[0].env !== EXPECTED_ENV)
    problems.push("container image or env is not the reviewed form");
  if (problems.length > 0) return { problems, summary: [] };

  // Resolve with the same semantics ARM applies: filter(secretMap, s => inject || s.vaultKey != 'googleWebRiskApiKey').
  const inject = m.properties.parameters.injectWebRiskKey.value;
  const active = inner.variables.secretMap.filter((s) => inject || s.vaultKey !== "googleWebRiskApiKey");
  if (!same(active, APPROVED.map(({ name, vaultKey, envName }) => ({ name, vaultKey, envName })))) problems.push("resolved secrets are not exactly the three approved staging secrets");
  if (val("stagingAppName") !== appName) problems.push("stagingAppName does not match the target app");
  if (val("keyVaultName") !== "kv-cbc-prod-cc-001" || val("registryName") !== "crcbcprodcc001" || val("identityName") !== "id-cbc-web-cc-001")
    problems.push("Key Vault, registry or runtime identity name is not the reviewed one");
  const secretNames = val("stagingSecretNames") ?? {};
  for (const a of APPROVED) if (secretNames[a.vaultKey] !== a.kvSecret) problems.push(`${a.name} does not reference Key Vault secret ${a.kvSecret}`);
  const plainEnv = val("stagingPlainEnv");
  if (!Array.isArray(plainEnv) || !plainEnv.every((e) => keysAre(e, ["name", "value"]) && typeof e.value === "string")) return fail("stagingPlainEnv is not a list of { name, value } strings");
  if (plainEnv.some((e) => e.name === "GOOGLE_WEB_RISK_API_KEY")) problems.push("stagingPlainEnv sets GOOGLE_WEB_RISK_API_KEY");
  if (plainEnv.some((e) => /KEY|SECRET|PASSWORD|TOKEN/.test(e.name))) problems.push("stagingPlainEnv holds a secret-named variable");
  if (plainEnv.filter((e) => e.name === "WEB_RISK_PROVIDER_ENABLED").map((e) => e.value).join() !== "false") problems.push('stagingPlainEnv must set WEB_RISK_PROVIDER_ENABLED exactly once to "false"');
  problems.push(...inngestProblems(plainEnv, null).map((p) => `stagingPlainEnv: ${p}`));
  const activePlain = plainEnv.filter((e) => inject || e.name !== "GOOGLE_WEB_RISK_API_KEY");
  const env = [...active.map((s) => ({ name: s.envName, secretRef: s.name })), { name: "PORT", value: "3000" }, { name: "HOSTNAME", value: "0.0.0.0" }, ...activePlain];
  const resolvedSecrets = active.map((s) => ({ name: s.name, keyVaultUrl: `${KEY_VAULT_URI}secrets/${secretNames[s.vaultKey]}` }));
  if (WEB_RISK_KEY.test(JSON.stringify({ resolvedSecrets, env }))) problems.push("resolved app configuration mentions the Google Web Risk key");
  if (new Set(env.map((e) => e.name)).size !== env.length) problems.push("duplicate environment variable names");
  return { problems, summary: [`secrets ${active.map((s) => s.name).join(", ")}`, `env ${env.map((e) => e.name).join(", ")}`] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mode, file, ...rest] = process.argv.slice(2);
  const json = JSON.parse(readFileSync(file, "utf8"));
  const { problems, summary } =
    mode === "template" ? checkTemplate(json, rest[0], rest[1]) :
    mode === "whatif" ? checkWhatIf(json, rest[0], rest[1]) :
    mode === "config" ? checkConfig(json, rest[0]) :
    { problems: [`unknown mode ${mode}`], summary: [] };
  for (const line of summary) console.log(line);
  for (const p of problems) console.log(`::error::${p}`);
  console.log(problems.length === 0 ? "staging guard: PASS" : `staging guard: FAIL (${problems.length})`);
  process.exit(problems.length === 0 ? 0 : 1);
}
