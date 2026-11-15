// Gate 008D: offline guard for a founder-captured `az deployment group what-if` of the clean-start Azure-native
// web (azure-only-web.bicep) or URL worker (azure-url-worker-job.bicep).
//
// It never contacts Azure, never reads secrets and never deploys. Input is the JSON an authorized operator
// captured with read-only what-if (`--no-pretty-print --output json`); expectations come from
// infra/azure/cleanstart/cutover-profile.json. Any doubt fails closed. Passing this guard is NECESSARY, not
// sufficient: a human still reviews the what-if before any separately approved apply.
//
// Usage:
//   node scripts/azure-data/check-cleanstart-whatif.mjs --profile <profile.json> --component web|worker \
//     --enabled true|false --whatif <whatif.json> [--image-digest <64 hex>]
import { readFileSync } from "node:fs";

export const ROLE = {
  acrPull: "7f951dda-4ed3-4680-a7ca-43fe172d538d",
  kvSecretsUser: "4633458b-17de-408a-b874-0445c86b69e6",
};
const LEGACY_WEB_IDENTITY = "id-cbc-web-cc-001";
const NAME = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const SECRET_NAME = /^[A-Za-z0-9-]{1,127}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const FORBIDDEN_ENV = /SUPABASE|INNGEST|SERVICE_ROLE|PASSWORD|GOOGLE_WEB_RISK|WEB_RISK/i;
const SECRETISH = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /postgres(ql)?:\/\/[^:\s/@]+:[^@\s]+@/i, /AccountKey=/i, /\bsig=[A-Za-z0-9%]{20,}/, /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./];

const lc = (s) => String(s ?? "").toLowerCase();
const isPlaceholder = (v) => typeof v === "string" && v.startsWith("REQUIRED:");

// ------------------------------------------------------------------------------------------- profile
export function validateProfile(p, { requireComplete }) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(p && p.schemaVersion === 1, "profile schemaVersion must be 1");
  if (!p) return problems;
  const text = JSON.stringify(p);
  for (const re of SECRETISH) need(!re.test(text), "profile contains secret-looking material (" + re.source.slice(0, 24) + ")");
  const placeholders = [];
  (function walk(v, path) {
    if (isPlaceholder(v)) placeholders.push(path);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? path + "." + k : k);
  })(p, "");
  if (requireComplete) need(placeholders.length === 0, "profile still has REQUIRED placeholders: " + placeholders.join(", "));

  const filled = (v) => !isPlaceholder(v);
  if (filled(p.subscriptionId)) need(GUID.test(p.subscriptionId), "subscriptionId must be a lowercase GUID");
  if (filled(p.tenantId)) need(GUID.test(p.tenantId), "tenantId must be a lowercase GUID");
  need(/^[A-Za-z0-9._()-]{1,90}$/.test(p.resourceGroup ?? ""), "resourceGroup invalid");
  need(p.location === "canadacentral", "location must stay canadacentral (existing environment region)");
  const e = p.existing ?? {}, w = p.web ?? {}, k = p.worker ?? {}, d = p.database ?? {};
  for (const n of ["environmentName", "registryName", "keyVaultName", "postgresServerName"]) need(typeof e[n] === "string" && e[n].length > 2, "existing." + n + " required");
  for (const n of ["webIdentityName", "webAppName"]) need(NAME.test(w[n] ?? ""), "web." + n + " invalid");
  for (const n of ["workerIdentityName", "workerJobName"]) need(NAME.test(k[n] ?? ""), "worker." + n + " invalid");
  for (const n of ["oidcStateSecretName", "oidcClientKeySecretName", "oidcClientCertSecretName"]) need(SECRET_NAME.test(w[n] ?? ""), "web." + n + " invalid");
  need(new Set([w.oidcStateSecretName, w.oidcClientKeySecretName, w.oidcClientCertSecretName]).size === 3, "the three OIDC secrets must be distinct");
  need(SECRET_NAME.test(k.webRiskSecretName ?? ""), "worker.webRiskSecretName invalid");
  need(w.webIdentityName !== LEGACY_WEB_IDENTITY, "web identity must not be the legacy broad-vault identity " + LEGACY_WEB_IDENTITY);
  need(w.webIdentityName !== k.workerIdentityName, "web and worker identities must differ");
  need(w.minReplicas === 0, "web.minReplicas must be 0 until a deliberate always-on cost decision");
  need(["*/5 * * * *", "*/15 * * * *", "0 * * * *"].includes(k.scheduleCron), "worker.scheduleCron must be an allowed template value");
  need(d.host === `${e.postgresServerName}.postgres.database.azure.com`, "database.host must be the existing server FQDN");
  need(/^[a-z_][a-z0-9_]{0,62}$/.test(d.name ?? "") && !["postgres", "azure_maintenance", "azure_sys"].includes(d.name), "database.name invalid or reserved");
  need(d.webRole === "cbc_app" && d.workerRole === "cbc_worker", "database roles must be cbc_app / cbc_worker (templates hard-code them)");
  const protectedKeys = new Set((p.protectedExisting ?? []).map((r) => lc(r.type) + "/" + lc(r.name)));
  need(protectedKeys.size >= 8, "protectedExisting must list the existing CBC resources");
  for (const [type, name] of [["Microsoft.ManagedIdentity/userAssignedIdentities", w.webIdentityName], ["Microsoft.App/containerApps", w.webAppName],
    ["Microsoft.ManagedIdentity/userAssignedIdentities", k.workerIdentityName], ["Microsoft.App/jobs", k.workerJobName]]) {
    need(!protectedKeys.has(lc(type) + "/" + lc(name)), `new ${type} ${name} collides with a protected existing resource`);
  }
  if (filled(w.publicOrigin)) {
    let ok = false;
    try { const u = new URL(w.publicOrigin); ok = u.protocol === "https:" && u.origin === w.publicOrigin; } catch { /* invalid */ }
    need(ok, "web.publicOrigin must be a canonical https origin");
  }
  if (filled(w.oidcIssuer)) need(/^https:\/\/[a-z0-9.-]+\/(?:[A-Za-z0-9._~-]+\/)+v2\.0$/.test(w.oidcIssuer), "web.oidcIssuer must be an https .../v2.0 issuer");
  if (filled(w.oidcClientId)) need(GUID.test(w.oidcClientId), "web.oidcClientId must be a lowercase GUID");
  return problems;
}

// ------------------------------------------------------------------------------------------- what-if
export function expectedIds(p) {
  const rg = `/subscriptions/${p.subscriptionId}/resourceGroups/${p.resourceGroup}`;
  const kv = `${rg}/providers/Microsoft.KeyVault/vaults/${p.existing.keyVaultName}`;
  return {
    rg,
    registry: `${rg}/providers/Microsoft.ContainerRegistry/registries/${p.existing.registryName}`,
    secret: (n) => `${kv}/secrets/${n}`,
    webIdentity: `${rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${p.web.webIdentityName}`,
    webApp: `${rg}/providers/Microsoft.App/containerApps/${p.web.webAppName}`,
    workerIdentity: `${rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${p.worker.workerIdentityName}`,
    workerJob: `${rg}/providers/Microsoft.App/jobs/${p.worker.workerJobName}`,
    roleDef: (g) => `/subscriptions/${p.subscriptionId}/providers/Microsoft.Authorization/roleDefinitions/${g}`,
  };
}

const roleScope = (id) => {
  const m = /^(.*)\/providers\/Microsoft\.Authorization\/roleAssignments\/[0-9a-f-]{36}$/i.exec(id ?? "");
  return m ? m[1] : null;
};
const envMap = (container) => new Map((container?.env ?? []).map((e) => [e.name, e]));
// A new identity's clientId is unknown at what-if time: accept a GUID or an unresolved reference to that identity.
const identityRef = (v, identityName) => (typeof v === "string" && (GUID.test(v) || (v.startsWith("[") && v.includes(identityName))));

export function checkWhatIf(p, result, { component, enabled, imageDigest }) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  problems.push(...validateProfile(p, { requireComplete: true }));
  if (problems.length) return { problems, summary: [] };
  need(component === "web" || component === "worker", "component must be web or worker");
  need(typeof enabled === "boolean", "enabled must be true or false");
  if (enabled) need(DIGEST.test(imageDigest ?? ""), "an approved image digest (64 lowercase hex) is required when enabled");

  need(result?.status === "Succeeded", `what-if status is ${result?.status ?? "missing"}`);
  need(!result?.error, "what-if returned an error");
  need((result?.potentialChanges ?? []).length === 0, "what-if reported potential changes it could not evaluate");
  for (const d of result?.diagnostics ?? []) need(lc(d?.level) === "info", `what-if diagnostic ${d?.level ?? "?"} ${d?.code ?? ""}`.trim());
  const changes = Array.isArray(result?.changes) ? result.changes : [];
  need(Array.isArray(result?.changes), "what-if has no changes array");
  const text = JSON.stringify(result ?? {});
  for (const re of SECRETISH) need(!re.test(text), "what-if output contains secret-looking material; do not attach it anywhere");

  const ids = expectedIds(p);
  const protectedKeys = new Set(p.protectedExisting.map((r) => lc(r.type) + "/" + lc(r.name)));
  const keyOf = (id) => { const m = /\/providers\/([^/]+\/[^/]+)\/([^/]+)$/i.exec(id ?? ""); return m ? lc(m[1]) + "/" + lc(m[2]) : ""; };

  // what may be created, keyed by lower-case resource id (role assignments by scope + role)
  const want = new Map();
  const roleWant = [];
  if (enabled && component === "web") {
    want.set(lc(ids.webIdentity), "identity");
    want.set(lc(ids.webApp), "web");
    roleWant.push([ids.registry, ROLE.acrPull], [ids.secret(p.web.oidcStateSecretName), ROLE.kvSecretsUser],
      [ids.secret(p.web.oidcClientKeySecretName), ROLE.kvSecretsUser], [ids.secret(p.web.oidcClientCertSecretName), ROLE.kvSecretsUser]);
  }
  if (enabled && component === "worker") {
    want.set(lc(ids.workerIdentity), "identity");
    want.set(lc(ids.workerJob), "job");
    roleWant.push([ids.registry, ROLE.acrPull], [ids.secret(p.worker.webRiskSecretName), ROLE.kvSecretsUser]);
  }

  const seen = new Set();
  const roleSeen = [];
  for (const c of changes) {
    const id = c?.resourceId;
    need(typeof id === "string" && lc(id).startsWith(lc(ids.rg) + "/"), `change outside ${p.resourceGroup}: ${id ?? "(no id)"}`);
    if (["NoChange", "Ignore"].includes(c?.changeType)) continue;
    need(c?.changeType === "Create", `${c?.changeType ?? "unknown"} is never allowed for a clean-start provisioning: ${id}`);
    if (c?.changeType !== "Create") continue;
    need(!protectedKeys.has(keyOf(id)), `protected existing resource would be created/overwritten: ${id}`);
    const scope = roleScope(id);
    if (scope) {
      const def = String(c?.after?.properties?.roleDefinitionId ?? "");
      const match = roleWant.find(([s, r]) => lc(s) === lc(scope) && lc(def) === lc(ids.roleDef(r)));
      need(Boolean(match), `unexpected role assignment at ${scope} (${def.split("/").pop() || "no role"}); only the exact registry and named secrets are allowed`);
      need(c?.after?.properties?.principalType === "ServicePrincipal", `role assignment at ${scope} must target the managed identity (ServicePrincipal)`);
      if (match) roleSeen.push(match);
      continue;
    }
    const kind = want.get(lc(id));
    need(Boolean(kind), `unexpected Create: ${id}`);
    if (!kind) continue;
    seen.add(lc(id));
    if (kind === "web") problems.push(...checkWebApp(p, ids, c.after, imageDigest));
    if (kind === "job") problems.push(...checkWorkerJob(p, ids, c.after, imageDigest));
  }
  for (const id of want.keys()) need(seen.has(id), `expected Create missing: ${id}`);
  for (const r of roleWant) need(roleSeen.filter((x) => x === r).length === 1, `expected exactly one role assignment ${r[1]} at ${r[0]}`);
  return { problems, summary: changes.map((c) => `${c?.changeType} ${c?.resourceId}`) };
}

function checkWebApp(p, ids, after, digest) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push("web app: " + msg); };
  const props = after?.properties ?? {};
  const cfg = props.configuration ?? {};
  const ua = Object.keys(after?.identity?.userAssignedIdentities ?? {});
  need(after?.identity?.type === "UserAssigned" && ua.length === 1 && lc(ua[0]) === lc(ids.webIdentity), "only the new web identity may be assigned");
  need(cfg.ingress?.external === true && cfg.ingress?.allowInsecure === false && cfg.ingress?.targetPort === 3000, "ingress must be external HTTPS-only on 3000");
  need(cfg.activeRevisionsMode === "Single", "activeRevisionsMode must be Single");
  const regs = cfg.registries ?? [];
  need(regs.length === 1 && regs[0].server === `${p.existing.registryName}.azurecr.io` && lc(regs[0].identity) === lc(ids.webIdentity) && !regs[0].passwordSecretRef, "registry pull must use the web identity on the existing registry");
  const secrets = cfg.secrets ?? [];
  const wantSecrets = { "oidc-state-keys": p.web.oidcStateSecretName, "oidc-client-private-key": p.web.oidcClientKeySecretName, "oidc-client-certificate": p.web.oidcClientCertSecretName };
  need(secrets.length === 3, "exactly three Key Vault secret references");
  for (const s of secrets) {
    need(Object.hasOwn(wantSecrets, s.name), "unexpected secret " + s.name);
    need(!("value" in s), "secret " + s.name + " must be a Key Vault reference, never an inline value");
    need(s.keyVaultUrl === `https://${p.existing.keyVaultName}.vault.azure.net/secrets/${wantSecrets[s.name]}`, "secret " + s.name + " must reference its named secret only");
    need(lc(s.identity) === lc(ids.webIdentity), "secret " + s.name + " must resolve with the web identity");
  }
  const containers = props.template?.containers ?? [];
  need(containers.length === 1, "exactly one container");
  const c = containers[0] ?? {};
  need(c.image === `${p.existing.registryName}.azurecr.io/cbc-azure-web@sha256:${digest}`, "image must be the approved cbc-azure-web digest");
  const env = envMap(c);
  const expected = {
    CBC_AZURE_ONLY_MODE: "1", CBC_AZURE_PUBLIC_ORIGIN: p.web.publicOrigin, CBC_AZURE_OIDC_ISSUER: p.web.oidcIssuer,
    CBC_AZURE_OIDC_CLIENT_ID: p.web.oidcClientId, CBC_AZURE_OIDC_STATE_ACTIVE_KID: p.web.oidcStateActiveKid,
    CBC_DATABASE_URL: `postgres://${p.database.webRole}@${p.database.host}:5432/${p.database.name}`, CBC_DATABASE_AUTH: "entra",
    PORT: "3000", HOSTNAME: "0.0.0.0",
  };
  const secretEnv = { CBC_AZURE_OIDC_STATE_KEYS: "oidc-state-keys", CBC_AZURE_OIDC_CLIENT_PRIVATE_KEY_PEM_B64: "oidc-client-private-key", CBC_AZURE_OIDC_CLIENT_CERT_PEM_B64: "oidc-client-certificate" };
  const allowed = new Set([...Object.keys(expected), ...Object.keys(secretEnv), "AZURE_CLIENT_ID"]);
  for (const name of env.keys()) {
    need(allowed.has(name), "unexpected environment variable " + name);
    need(!FORBIDDEN_ENV.test(name), "legacy or paid-provider credential variable " + name);
  }
  for (const [k, v] of Object.entries(expected)) need(env.get(k)?.value === v && !env.get(k)?.secretRef, `${k} must be ${v}`);
  for (const [k, ref] of Object.entries(secretEnv)) need(env.get(k)?.secretRef === ref && !("value" in (env.get(k) ?? {})), `${k} must come from secret ${ref}`);
  need(identityRef(env.get("AZURE_CLIENT_ID")?.value, p.web.webIdentityName), "AZURE_CLIENT_ID must be the web identity's client ID");
  const scale = props.template?.scale ?? {};
  need(scale.minReplicas === p.web.minReplicas && scale.maxReplicas === 1, "scale must be min " + p.web.minReplicas + " / max 1");
  return problems;
}

function checkWorkerJob(p, ids, after, digest) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push("worker job: " + msg); };
  const props = after?.properties ?? {};
  const cfg = props.configuration ?? {};
  const ua = Object.keys(after?.identity?.userAssignedIdentities ?? {});
  need(after?.identity?.type === "UserAssigned" && ua.length === 1 && lc(ua[0]) === lc(ids.workerIdentity), "only the worker identity may be assigned");
  need(!("ingress" in cfg), "a job has no ingress");
  need(cfg.triggerType === "Schedule" && cfg.scheduleTriggerConfig?.cronExpression === p.worker.scheduleCron, "schedule must be " + p.worker.scheduleCron);
  need(cfg.scheduleTriggerConfig?.parallelism === 1 && cfg.replicaRetryLimit === 0, "single replica, no platform retries");
  const secrets = cfg.secrets ?? [];
  need(secrets.length === 1 && secrets[0].name === "web-risk-key" && !("value" in secrets[0]) &&
    secrets[0].keyVaultUrl === `https://${p.existing.keyVaultName}.vault.azure.net/secrets/${p.worker.webRiskSecretName}` &&
    lc(secrets[0].identity) === lc(ids.workerIdentity), "exactly one Key Vault reference: the Web Risk key, via the worker identity");
  const c = (props.template?.containers ?? [])[0] ?? {};
  need((props.template?.containers ?? []).length === 1, "exactly one container");
  need(c.image === `${p.existing.registryName}.azurecr.io/cbc-azure-worker@sha256:${digest}`, "image must be the approved cbc-azure-worker digest");
  const env = envMap(c);
  for (const name of env.keys()) {
    need(["CBC_WORKER_DATABASE_URL", "CBC_WORKER_AZURE_CLIENT_ID", "AZURE_CLIENT_ID", "CBC_WEB_RISK_API_KEY"].includes(name), "unexpected environment variable " + name);
    need(!/SUPABASE|INNGEST|SERVICE_ROLE|PASSWORD/i.test(name), "legacy credential variable " + name);
  }
  need(env.get("CBC_WORKER_DATABASE_URL")?.value === `postgres://${p.database.workerRole}@${p.database.host}:5432/${p.database.name}`, "worker must connect as " + p.database.workerRole + " without a password");
  need(env.get("CBC_WEB_RISK_API_KEY")?.secretRef === "web-risk-key" && !("value" in (env.get("CBC_WEB_RISK_API_KEY") ?? {})), "the Web Risk key must be a secret reference");
  need(identityRef(env.get("CBC_WORKER_AZURE_CLIENT_ID")?.value, p.worker.workerIdentityName), "CBC_WORKER_AZURE_CLIENT_ID must be the worker identity");
  need(identityRef(env.get("AZURE_CLIENT_ID")?.value, p.web.webIdentityName), "AZURE_CLIENT_ID (identity-separation check) must be the web identity");
  return problems;
}

// ------------------------------------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
  const profilePath = arg("profile"), whatifPath = arg("whatif"), component = arg("component"), enabledRaw = arg("enabled");
  if (!profilePath || !whatifPath || !component || !["true", "false"].includes(enabledRaw ?? "")) {
    console.error("usage: check-cleanstart-whatif.mjs --profile <p.json> --component web|worker --enabled true|false --whatif <w.json> [--image-digest <hex>]");
    process.exit(2);
  }
  const { problems, summary } = checkWhatIf(JSON.parse(readFileSync(profilePath, "utf8")), JSON.parse(readFileSync(whatifPath, "utf8")),
    { component, enabled: enabledRaw === "true", imageDigest: arg("image-digest") });
  for (const s of summary) console.log("  " + s);
  if (problems.length) {
    for (const x of problems) console.error("REFUSE: " + x);
    process.exit(1);
  }
  console.log(`clean-start what-if accepted for ${component} (enabled=${enabledRaw}). A human review is still required before any approved apply.`);
}
