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
//     --enabled true|false --whatif <whatif.json> [--image-digest <64 hex>] [--principal-id <guid>]
//   --principal-id: the intended identity's principal (object) ID from authenticated evidence; required only when
//   the what-if shows concrete principal GUIDs instead of the unresolved compiled expression.
//   node scripts/azure-data/check-cleanstart-whatif.mjs --compiled-drift --web <web.arm.json> --worker <worker.arm.json> --network <net.arm.json>
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
  problems.push(...validateNetworkProfile(p, protectedKeys));
  if (filled(w.oidcIssuer)) need(/^https:\/\/[a-z0-9.-]+\/(?:[A-Za-z0-9._~-]+\/)+v2\.0$/.test(w.oidcIssuer), "web.oidcIssuer must be an https .../v2.0 issuer");
  if (filled(w.oidcClientId)) need(GUID.test(w.oidcClientId), "web.oidcClientId must be a lowercase GUID");
  return problems;
}

// ------------------------------------------------------------------------------------------- network profile
// IPv4 CIDR helpers (no dependency).
export function parseCidr(cidr) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(cidr ?? ""));
  if (!m) return null;
  const octets = m.slice(1, 5).map(Number), bits = Number(m[5]);
  if (octets.some((o) => o > 255) || bits > 32) return null;
  const ip = ((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3];
  const size = 2 ** (32 - bits);
  if (ip % size !== 0) return null;                       // must be the network address, not a host inside it
  return { start: ip, end: ip + size - 1, bits };
}
const inside = (a, b) => a.start >= b.start && a.end <= b.end;
const overlaps = (a, b) => a.start <= b.end && b.start <= a.end;
const RFC1918 = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map(parseCidr);

function validateNetworkProfile(p, protectedKeys) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  const n = p.network;
  need(n && typeof n === "object", "network section required (Gate 008E private network)");
  if (!n) return problems;
  for (const k of ["vnetName", "environmentName", "privateEndpointName"]) need(NAME.test(n[k] ?? ""), "network." + k + " invalid");
  need(n.environmentName !== p.existing?.environmentName, "network.environmentName must be a NEW environment, not the existing " + p.existing?.environmentName);
  for (const [type, name] of [["Microsoft.Network/virtualNetworks", n.vnetName], ["Microsoft.App/managedEnvironments", n.environmentName], ["Microsoft.Network/privateEndpoints", n.privateEndpointName]]) {
    need(!protectedKeys.has(lc(type) + "/" + lc(name)), `new ${type} ${name} collides with a protected existing resource`);
  }
  const vnet = parseCidr(n.vnetAddressPrefix), apps = parseCidr(n.appsSubnetPrefix), pe = parseCidr(n.endpointSubnetPrefix);
  need(vnet && apps && pe, "network prefixes must be valid IPv4 network CIDRs");
  if (vnet && apps && pe) {
    need(RFC1918.some((r) => inside(vnet, r)), "network.vnetAddressPrefix must be private (RFC 1918) address space");
    need(inside(apps, vnet) && inside(pe, vnet), "both subnets must lie inside the virtual network");
    need(!overlaps(apps, pe), "the two subnets must not overlap");
    need(apps.bits <= 27, "the Container Apps subnet must be /27 or larger (workload-profiles minimum; cannot be resized later)");
    need(pe.bits <= 28 && pe.bits >= 24, "the private endpoint subnet must be between /28 and /24");
    need(vnet.bits >= 16, "the virtual network must not be larger than /16");
  }
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
    postgres: `${rg}/providers/Microsoft.DBforPostgreSQL/flexibleServers/${p.existing.postgresServerName}`,
    vnet: `${rg}/providers/Microsoft.Network/virtualNetworks/${p.network?.vnetName}`,
    appsSubnet: `${rg}/providers/Microsoft.Network/virtualNetworks/${p.network?.vnetName}/subnets/snet-cbc-aca`,
    endpointSubnet: `${rg}/providers/Microsoft.Network/virtualNetworks/${p.network?.vnetName}/subnets/snet-cbc-pe`,
    dnsZone: `${rg}/providers/Microsoft.Network/privateDnsZones/privatelink.postgres.database.azure.com`,
    dnsLink: `${rg}/providers/Microsoft.Network/privateDnsZones/privatelink.postgres.database.azure.com/virtualNetworkLinks/${p.network?.vnetName}-link`,
    endpoint: `${rg}/providers/Microsoft.Network/privateEndpoints/${p.network?.privateEndpointName}`,
    endpointDns: `${rg}/providers/Microsoft.Network/privateEndpoints/${p.network?.privateEndpointName}/privateDnsZoneGroups/default`,
    newEnvironment: `${rg}/providers/Microsoft.App/managedEnvironments/${p.network?.environmentName}`,
    existingEnvironment: `${rg}/providers/Microsoft.App/managedEnvironments/${p.existing.environmentName}`,
  };
}

const roleScope = (id) => {
  const m = /^(.*)\/providers\/Microsoft\.Authorization\/roleAssignments\/[0-9a-f-]{36}$/i.exec(id ?? "");
  return m ? m[1] : null;
};
const envMap = (container) => new Map((container?.env ?? []).map((e) => [e.name, e]));
// Gate 008D hardening (lead review 6899949127): a role assignment is only acceptable for the INTENDED identity.
// The compiled Bicep (az bicep 0.48.1) emits exactly:
//   [reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', parameters('<param>')), '2023-01-31').principalId]
// with <param> = webIdentityName (web template) or workerIdentityName (worker template). A new identity's principal ID
// is unknown at what-if time, so the expression may appear unresolved. Accepted forms, all bound to ONE identity:
//   - that expression with parameters('<the component's own identity parameter>') - the same what-if must also
//     Create the identity under the profile name (checked separately), which binds the parameter value;
//   - the same expression with the identity name as a literal, or its full resource ID as a literal;
//   - a GUID, only when it equals a principal ID the operator supplied from authenticated evidence.
// Anything else - another identity, the other component's parameter, an arbitrary service principal, extra
// expression text, a missing value - fails closed.
export const COMPILED_PRINCIPAL = (param) =>
  `[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', parameters('${param}')), '2023-01-31').principalId]`;
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
export function principalBinding(value, { param, identityName, identityId, knownPrincipalId }) {
  if (typeof value !== "string" || value.length === 0) return "principalId is missing";
  if (GUID.test(value)) {
    if (!knownPrincipalId) return "principalId is a concrete GUID but no expected principal ID was supplied (--principal-id from authenticated evidence)";
    return value === knownPrincipalId ? null : "principalId " + value + " is not the intended identity's principal";
  }
  const head = "^\\[reference\\(";
  const tail = ", '2023-01-31'(?:, 'Full')?\\)\\.principalId\\]$";
  const forms = [
    new RegExp(head + "resourceId\\('Microsoft\\.ManagedIdentity/userAssignedIdentities', parameters\\('" + escapeRe(param) + "'\\)\\)" + tail),
    new RegExp(head + "resourceId\\('Microsoft\\.ManagedIdentity/userAssignedIdentities', '" + escapeRe(identityName) + "'\\)" + tail),
    new RegExp(head + "'" + escapeRe(identityId) + "'" + tail, "i"),
  ];
  return forms.some((re) => re.test(value)) ? null : "principalId does not reference the intended identity " + identityName + ": " + value.slice(0, 160);
}

// A new identity's clientId is unknown at what-if time: accept a GUID or an unresolved reference to that identity.
const identityRef = (v, identityName) => (typeof v === "string" && (GUID.test(v) || (v.startsWith("[") && v.includes(identityName))));

export function checkWhatIf(p, result, { component, enabled, imageDigest, principalId }) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  problems.push(...validateProfile(p, { requireComplete: true }));
  if (problems.length) return { problems, summary: [] };
  need(["web", "worker", "network"].includes(component), "component must be web, worker or network");
  need(typeof enabled === "boolean", "enabled must be true or false");
  if (enabled && component !== "network") need(DIGEST.test(imageDigest ?? ""), "an approved image digest (64 lowercase hex) is required when enabled");

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
  if (enabled && component === "network") {
    want.set(lc(ids.vnet), "vnet");
    want.set(lc(ids.dnsZone), "dnsZone");
    want.set(lc(ids.dnsLink), "dnsLink");
    want.set(lc(ids.endpoint), "endpoint");
    want.set(lc(ids.endpointDns), "endpointDns");
    want.set(lc(ids.newEnvironment), "environment");
  }
  if (enabled && component === "worker") {
    want.set(lc(ids.workerIdentity), "identity");
    want.set(lc(ids.workerJob), "job");
    roleWant.push([ids.registry, ROLE.acrPull], [ids.secret(p.worker.webRiskSecretName), ROLE.kvSecretsUser]);
  }

  const seen = new Set();
  const roleSeen = [];
  const allIds = new Set();
  const binding = component === "worker"
    ? { param: "workerIdentityName", identityName: p.worker.workerIdentityName, identityId: ids.workerIdentity, knownPrincipalId: principalId }
    : { param: "webIdentityName", identityName: p.web.webIdentityName, identityId: ids.webIdentity, knownPrincipalId: principalId };
  if (principalId !== undefined && principalId !== null) need(GUID.test(principalId), "a supplied principal ID must be a lowercase GUID");
  for (const c of changes) {
    const id = c?.resourceId;
    need(!allIds.has(lc(id)), `duplicate change for one resource ID: ${id}`);
    allIds.add(lc(id));
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
      const why = principalBinding(c?.after?.properties?.principalId, binding);
      need(why === null, `role assignment at ${scope}: ${why}`);
      if (match) roleSeen.push(match);
      continue;
    }
    const kind = want.get(lc(id));
    need(Boolean(kind), `unexpected Create: ${id}`);
    if (!kind) continue;
    seen.add(lc(id));
    if (kind === "web") problems.push(...checkWebApp(p, ids, c.after, imageDigest));
    if (kind === "job") problems.push(...checkWorkerJob(p, ids, c.after, imageDigest));
    if (component === "network") problems.push(...checkNetworkResource(kind, p, ids, c.after));
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
  need(lc(props.managedEnvironmentId) === lc(ids.newEnvironment), "must run in the NEW private-network environment " + p.network.environmentName + ", never the existing one");
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
  need(lc(props.environmentId) === lc(ids.newEnvironment), "must run in the NEW private-network environment " + p.network.environmentName + ", never the existing one");
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

// ------------------------------------------------------------------------------------------- network resources
function checkNetworkResource(kind, p, ids, after) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(kind + ": " + msg); };
  const props = after?.properties ?? {};
  const n = p.network;
  if (kind === "vnet") {
    need(JSON.stringify(props.addressSpace?.addressPrefixes) === JSON.stringify([n.vnetAddressPrefix]), "address space must be exactly " + n.vnetAddressPrefix);
    const subnets = props.subnets ?? [];
    need(subnets.length === 2, "exactly two subnets");
    const apps = subnets.find((x) => x.name === "snet-cbc-aca"), pe = subnets.find((x) => x.name === "snet-cbc-pe");
    need(apps?.properties?.addressPrefix === n.appsSubnetPrefix, "Container Apps subnet must be " + n.appsSubnetPrefix);
    const del = apps?.properties?.delegations ?? [];
    need(del.length === 1 && del[0]?.properties?.serviceName === "Microsoft.App/environments", "Container Apps subnet must be delegated to Microsoft.App/environments only");
    need(pe?.properties?.addressPrefix === n.endpointSubnetPrefix && (pe?.properties?.delegations ?? []).length === 0, "endpoint subnet must be " + n.endpointSubnetPrefix + " with no delegation");
    need((props.virtualNetworkPeerings ?? []).length === 0, "no peering");
    need(props.enableDdosProtection !== true && !props.ddosProtectionPlan, "no DDoS protection plan (separate cost decision)");
    for (const sn of subnets) need(!sn?.properties?.natGateway && !sn?.properties?.routeTable, `subnet ${sn?.name} must not attach a NAT gateway or route table`);
  }
  if (kind === "dnsZone") need(lc(after?.location ?? "global") === "global", "private DNS zones are global");
  if (kind === "dnsLink") {
    need(props.registrationEnabled === false, "auto-registration must be off");
    need(lc(props.virtualNetwork?.id) === lc(ids.vnet), "must link only the new virtual network");
  }
  if (kind === "endpoint") {
    need(lc(props.subnet?.id) === lc(ids.endpointSubnet), "must sit in the endpoint subnet");
    const conns = props.privateLinkServiceConnections ?? [];
    need(conns.length === 1 && (props.manualPrivateLinkServiceConnections ?? []).length === 0, "exactly one automatic private link connection");
    need(lc(conns[0]?.properties?.privateLinkServiceId) === lc(ids.postgres), "must target the existing server " + p.existing.postgresServerName + " exactly");
    need(JSON.stringify(conns[0]?.properties?.groupIds) === '["postgresqlServer"]', "groupIds must be [postgresqlServer]");
  }
  if (kind === "endpointDns") {
    const cfgs = props.privateDnsZoneConfigs ?? [];
    need(cfgs.length === 1 && lc(cfgs[0]?.properties?.privateDnsZoneId) === lc(ids.dnsZone), "must register only in privatelink.postgres.database.azure.com");
  }
  if (kind === "environment") {
    need(lc(props.vnetConfiguration?.infrastructureSubnetId) === lc(ids.appsSubnet), "must use the delegated Container Apps subnet");
    need(props.vnetConfiguration?.internal === false, "ingress must stay external (public website)");
    const wp = props.workloadProfiles ?? [];
    need(wp.length === 1 && wp[0]?.workloadProfileType === "Consumption", "Consumption workload profile only (a Dedicated profile adds a management charge)");
    need(props.zoneRedundant !== true, "zone redundancy is a separate cost decision");
    const la = props.appLogsConfiguration?.logAnalyticsConfiguration ?? {};
    need(props.appLogsConfiguration?.destination === "log-analytics", "logs go to the existing Log Analytics workspace");
    need(!la.sharedKey || /^\[/.test(la.sharedKey) || la.sharedKey === "*******", "the workspace key must not appear in clear in the what-if");
  }
  return problems;
}

// Compiled azure-private-network.bicep: every resource conditional on deployNetwork (default false), exactly the
// six expected types, never a firewall rule / public IP / NAT / peering / gateway, endpoint on postgresqlServer.
export function checkCompiledNetwork(template) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(template?.parameters?.deployNetwork?.defaultValue === false, "deployNetwork must default to false");
  const resources = Array.isArray(template?.resources) ? template.resources : Object.values(template?.resources ?? {});
  const created = resources.filter((r) => !r?.existing);
  const types = created.map((r) => r.type).sort();
  need(JSON.stringify(types) === JSON.stringify(["Microsoft.App/managedEnvironments", "Microsoft.Network/privateDnsZones", "Microsoft.Network/privateDnsZones/virtualNetworkLinks",
    "Microsoft.Network/privateEndpoints", "Microsoft.Network/privateEndpoints/privateDnsZoneGroups", "Microsoft.Network/virtualNetworks"]), "unexpected compiled resource set: " + types.join(","));
  for (const r of created) need(r.condition === "[parameters('deployNetwork')]", `${r.type} must be conditional on deployNetwork only`);
  const text = JSON.stringify(template);
  need(!/flexibleServers\/firewallRules|publicIPAddresses|natGateways|virtualNetworkPeerings|virtualNetworkGateways|ddosProtectionPlans|bastionHosts/.test(text), "forbidden resource type referenced");
  need(!/0\.0\.0\.0/.test(text), "no 0.0.0.0 address anywhere");
  need(text.includes('"groupIds":["postgresqlServer"]'), "endpoint groupIds must be postgresqlServer");
  need(text.includes('"name":"privatelink.postgres.database.azure.com"') || text.includes("privatelink.postgres.database.azure.com"), "private DNS zone name");
  const env = created.find((r) => r.type === "Microsoft.App/managedEnvironments");
  need(JSON.stringify(env?.properties?.workloadProfiles) === '[{"name":"Consumption","workloadProfileType":"Consumption"}]', "environment must be Consumption-only");
  need(env?.properties?.vnetConfiguration?.internal === false, "environment ingress must be external");
  return problems;
}

// ------------------------------------------------------------------------------------------- compiled drift
// Run on freshly compiled ARM JSON (CI compiled-iac job): every role assignment in each template must bind exactly
// the expression principalBinding() accepts for that template's own identity.
export function checkCompiledPrincipals(template, param) {
  const problems = [];
  const resources = Array.isArray(template?.resources) ? template.resources : Object.values(template?.resources ?? {});
  const roles = resources.filter((r) => r?.type === "Microsoft.Authorization/roleAssignments");
  if (roles.length === 0) problems.push("no role assignments found in the compiled template");
  for (const r of roles) {
    if (r?.properties?.principalId !== COMPILED_PRINCIPAL(param)) problems.push(`role assignment ${r?.name ?? "?"} binds ${r?.properties?.principalId}, expected ${COMPILED_PRINCIPAL(param)}`);
    if (r?.properties?.principalType !== "ServicePrincipal") problems.push(`role assignment ${r?.name ?? "?"} principalType is not ServicePrincipal`);
  }
  return { problems, count: roles.length };
}

// ------------------------------------------------------------------------------------------- CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (n) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : undefined; };
  if (process.argv.includes("--compiled-drift")) {
    const web = checkCompiledPrincipals(JSON.parse(readFileSync(arg("web"), "utf8")), "webIdentityName");
    const worker = checkCompiledPrincipals(JSON.parse(readFileSync(arg("worker"), "utf8")), "workerIdentityName");
    const network = arg("network") ? checkCompiledNetwork(JSON.parse(readFileSync(arg("network"), "utf8"))) : ["--network <compiled azure-private-network.json> is required"];
    const problems = [...web.problems, ...worker.problems, ...network.map((x) => "network: " + x)];
    for (const x of problems) console.error("DRIFT: " + x);
    if (problems.length || web.count !== 4 || worker.count !== 2) { console.error(`expected 4 web and 2 worker role assignments, found ${web.count} and ${worker.count}`); process.exit(1); }
    console.log(`compiled templates match the what-if guard: ${web.count} web and ${worker.count} worker role assignments bound; private network default-off, 6 resources, no firewall rule`);
    process.exit(0);
  }
  const profilePath = arg("profile"), whatifPath = arg("whatif"), component = arg("component"), enabledRaw = arg("enabled");
  if (!profilePath || !whatifPath || !component || !["true", "false"].includes(enabledRaw ?? "")) {
    console.error("usage: check-cleanstart-whatif.mjs --profile <p.json> --component web|worker|network --enabled true|false --whatif <w.json> [--image-digest <hex>] [--principal-id <guid>]");
    process.exit(2);
  }
  const { problems, summary } = checkWhatIf(JSON.parse(readFileSync(profilePath, "utf8")), JSON.parse(readFileSync(whatifPath, "utf8")),
    { component, enabled: enabledRaw === "true", imageDigest: arg("image-digest"), principalId: arg("principal-id") });
  for (const s of summary) console.log("  " + s);
  if (problems.length) {
    for (const x of problems) console.error("REFUSE: " + x);
    process.exit(1);
  }
  console.log(`clean-start what-if accepted for ${component} (enabled=${enabledRaw}). A human review is still required before any approved apply.`);
}
