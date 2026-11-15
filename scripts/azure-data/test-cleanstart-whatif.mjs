// Gate 008D: offline self-tests for check-cleanstart-whatif.mjs and the cutover profile. No Azure, no secrets:
// what-if documents are synthetic, in the Azure CLI shape (status, changes[{resourceId, changeType, after}],
// potentialChanges, diagnostics), built from the resources azure-only-web.bicep / azure-url-worker-job.bicep declare.
// Run: node scripts/azure-data/test-cleanstart-whatif.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import { checkWhatIf, validateProfile, expectedIds, ROLE, COMPILED_PRINCIPAL, checkCompiledPrincipals, checkCompiledNetwork, parseCidr } from "./check-cleanstart-whatif.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const read = (f) => readFileSync(path.join(ROOT, f), "utf8");
let passed = 0, failed = 0;
function check(name, ok, info = "") {
  if (ok) { passed++; console.log("PASS " + name); } else { failed++; console.log("FAIL " + name + (info ? "  [" + info + "]" : "")); }
}
const clone = (x) => structuredClone(x);

// ---------------------------------------------------------------- the committed profile
const repoProfile = JSON.parse(read("infra/azure/cleanstart/cutover-profile.json"));
check("P01 committed profile is structurally valid (placeholders allowed)", validateProfile(repoProfile, { requireComplete: false }).length === 0,
  validateProfile(repoProfile, { requireComplete: false }).join("; "));
const incomplete = validateProfile(repoProfile, { requireComplete: true });
check("P02 committed profile is refused for real evidence while REQUIRED placeholders remain",
  incomplete.some((m) => m.includes("REQUIRED placeholders")) && ["subscriptionId", "tenantId", "web.publicOrigin", "web.oidcIssuer", "web.oidcClientId"].every((k) => incomplete.join(" ").includes(k)));
{
  const coll = read("scripts/azure-data/check-deployment-name-collisions.mjs");
  const listed = [...coll.matchAll(/\['(Microsoft\.[^']+)','([^']+)'\]/g)].map((m) => (m[1] + "/" + m[2]).toLowerCase()).sort();
  const prof = repoProfile.protectedExisting.map((r) => (r.type + "/" + r.name).toLowerCase()).sort();
  check("P03 protectedExisting matches check-deployment-name-collisions.mjs exactly", JSON.stringify(listed) === JSON.stringify(prof) && listed.length === 8, listed.join(","));
}
{
  const web = read("infra/azure/hosting/azure-only-web.bicep");
  const worker = read("infra/azure/hosting/azure-url-worker-job.bicep");
  const params = (src) => new Set([...src.matchAll(/^param (\w+)/gm)].map((m) => m[1]));
  const wp = params(web), kp = params(worker);
  check("P04 every profile web field is a parameter of azure-only-web.bicep", Object.keys(repoProfile.web).every((k) => wp.has(k)), [...Object.keys(repoProfile.web)].filter((k) => !wp.has(k)).join(","));
  check("P05 every profile worker field is a parameter of azure-url-worker-job.bicep", Object.keys(repoProfile.worker).every((k) => kp.has(k)), [...Object.keys(repoProfile.worker)].filter((k) => !kp.has(k)).join(","));
  // literals the guard relies on must still be what the templates emit (drift between guard and IaC)
  check("P06 web template literals match the guard (image repo, secret names, DB role, env, ingress)",
    web.includes("/cbc-azure-web@sha256:${webImageSha256}") && ["'oidc-state-keys'", "'oidc-client-private-key'", "'oidc-client-certificate'"].every((s) => web.includes(s)) &&
    web.includes("'postgres://cbc_app@${databaseHost}:5432/${databaseName}'") && web.includes("allowInsecure: false") && web.includes("maxReplicas: 1") &&
    web.includes(`acrPullRole = '${ROLE.acrPull}'`) && web.includes(`kvSecretsUserRole = '${ROLE.kvSecretsUser}'`) && web.includes("{ name: 'HOSTNAME', value: '0.0.0.0' }"));
  check("P07 worker template literals match the guard (image repo, secret, DB role, schedule, no retries)",
    worker.includes("/cbc-azure-worker@sha256:${workerImageSha256}") && worker.includes("name: 'web-risk-key'") &&
    worker.includes("'postgres://cbc_worker@${databaseHost}:5432/${databaseName}'") && worker.includes("replicaRetryLimit: 0") &&
    worker.includes(`roleAcrPull = '${ROLE.acrPull}'`) && worker.includes(`roleKeyVaultSecretsUser = '${ROLE.kvSecretsUser}'`));
}

// ---------------------------------------------------------------- a filled test profile (fake GUIDs)
const p = clone(repoProfile);
p.subscriptionId = "11111111-2222-4333-8444-555555555555";
p.tenantId = "66666666-7777-4888-8999-000000000000";
p.web.publicOrigin = "https://app.cbc.example";
p.web.oidcIssuer = "https://cbctenant.ciamlogin.com/66666666-7777-4888-8999-000000000000/v2.0";
p.web.oidcClientId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
check("P08 a filled profile is accepted", validateProfile(p, { requireComplete: true }).length === 0, validateProfile(p, { requireComplete: true }).join("; "));
const ids = expectedIds(p);
const DIGEST = "a".repeat(64);
const GUIDS = ["0f0e0d0c-0b0a-4909-8807-060504030201", "1f0e0d0c-0b0a-4909-8807-060504030201", "2f0e0d0c-0b0a-4909-8807-060504030201", "3f0e0d0c-0b0a-4909-8807-060504030201"];
// principalId as the compiled Bicep emits it (verified against az bicep 0.48.1 output; CI re-checks with --compiled-drift)
const role = (scope, r, i, principalId = COMPILED_PRINCIPAL("webIdentityName")) => ({ resourceId: `${scope}/providers/Microsoft.Authorization/roleAssignments/${GUIDS[i]}`, changeType: "Create",
  after: { properties: { roleDefinitionId: ids.roleDef(r), principalType: "ServicePrincipal", principalId } } });
const wrole = (scope, r, i) => role(scope, r, i, COMPILED_PRINCIPAL("workerIdentityName"));
const kvUrl = (n) => `https://${p.existing.keyVaultName}.vault.azure.net/secrets/${n}`;
const webAfter = () => ({
  identity: { type: "UserAssigned", userAssignedIdentities: { [ids.webIdentity]: {} } },
  properties: {
    managedEnvironmentId: ids.newEnvironment,
    configuration: {
      activeRevisionsMode: "Single",
      ingress: { external: true, targetPort: 3000, transport: "auto", allowInsecure: false },
      registries: [{ server: `${p.existing.registryName}.azurecr.io`, identity: ids.webIdentity }],
      secrets: [
        { name: "oidc-state-keys", keyVaultUrl: kvUrl(p.web.oidcStateSecretName), identity: ids.webIdentity },
        { name: "oidc-client-private-key", keyVaultUrl: kvUrl(p.web.oidcClientKeySecretName), identity: ids.webIdentity },
        { name: "oidc-client-certificate", keyVaultUrl: kvUrl(p.web.oidcClientCertSecretName), identity: ids.webIdentity },
      ],
    },
    template: {
      containers: [{
        name: "azure-web", image: `${p.existing.registryName}.azurecr.io/cbc-azure-web@sha256:${DIGEST}`,
        env: [
          { name: "CBC_AZURE_ONLY_MODE", value: "1" }, { name: "CBC_AZURE_PUBLIC_ORIGIN", value: p.web.publicOrigin },
          { name: "CBC_AZURE_OIDC_ISSUER", value: p.web.oidcIssuer }, { name: "CBC_AZURE_OIDC_CLIENT_ID", value: p.web.oidcClientId },
          { name: "CBC_AZURE_OIDC_STATE_ACTIVE_KID", value: "k1" }, { name: "CBC_AZURE_OIDC_STATE_KEYS", secretRef: "oidc-state-keys" },
          { name: "CBC_AZURE_OIDC_CLIENT_PRIVATE_KEY_PEM_B64", secretRef: "oidc-client-private-key" },
          { name: "CBC_AZURE_OIDC_CLIENT_CERT_PEM_B64", secretRef: "oidc-client-certificate" },
          { name: "CBC_DATABASE_URL", value: `postgres://cbc_app@${p.database.host}:5432/${p.database.name}` },
          { name: "CBC_DATABASE_AUTH", value: "entra" },
          { name: "AZURE_CLIENT_ID", value: `[reference('${p.web.webIdentityName}').clientId]` },
          { name: "PORT", value: "3000" }, { name: "HOSTNAME", value: "0.0.0.0" },
        ],
      }],
      scale: { minReplicas: 0, maxReplicas: 1 },
    },
  },
});
const webWhatIf = () => ({
  status: "Succeeded", error: null, potentialChanges: [], diagnostics: [{ level: "Info", code: "NestedDeploymentShortCircuited" }],
  changes: [
    { resourceId: ids.webIdentity, changeType: "Create", after: { name: p.web.webIdentityName } },
    role(ids.registry, ROLE.acrPull, 0),
    role(ids.secret(p.web.oidcStateSecretName), ROLE.kvSecretsUser, 1),
    role(ids.secret(p.web.oidcClientKeySecretName), ROLE.kvSecretsUser, 2),
    role(ids.secret(p.web.oidcClientCertSecretName), ROLE.kvSecretsUser, 3),
    { resourceId: ids.webApp, changeType: "Create", after: webAfter() },
    { resourceId: `${ids.rg}/providers/Microsoft.App/containerApps/ca-cbc-web-stg-cc-001`, changeType: "Ignore" },
  ],
});
const workerAfter = () => ({
  identity: { type: "UserAssigned", userAssignedIdentities: { [ids.workerIdentity]: {} } },
  properties: {
    environmentId: ids.newEnvironment,
    configuration: {
      triggerType: "Schedule", scheduleTriggerConfig: { cronExpression: p.worker.scheduleCron, parallelism: 1, replicaCompletionCount: 1 },
      replicaTimeout: 180, replicaRetryLimit: 0,
      registries: [{ server: `${p.existing.registryName}.azurecr.io`, identity: ids.workerIdentity }],
      secrets: [{ name: "web-risk-key", keyVaultUrl: kvUrl(p.worker.webRiskSecretName), identity: ids.workerIdentity }],
    },
    template: { containers: [{ name: "url-worker", image: `${p.existing.registryName}.azurecr.io/cbc-azure-worker@sha256:${DIGEST}`, env: [
      { name: "CBC_WORKER_DATABASE_URL", value: `postgres://cbc_worker@${p.database.host}:5432/${p.database.name}` },
      { name: "CBC_WORKER_AZURE_CLIENT_ID", value: `[reference('${p.worker.workerIdentityName}').clientId]` },
      { name: "AZURE_CLIENT_ID", value: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff" },
      { name: "CBC_WEB_RISK_API_KEY", secretRef: "web-risk-key" },
    ] }] },
  },
});
const workerWhatIf = () => ({
  status: "Succeeded", potentialChanges: [], diagnostics: [],
  changes: [
    { resourceId: ids.workerIdentity, changeType: "Create" },
    wrole(ids.registry, ROLE.acrPull, 0),
    wrole(ids.secret(p.worker.webRiskSecretName), ROLE.kvSecretsUser, 1),
    { resourceId: ids.workerJob, changeType: "Create", after: workerAfter() },
  ],
});
const run = (w, component = "web", enabled = true, digest = DIGEST, profile = p, principalId = undefined) => checkWhatIf(profile, w, { component, enabled, imageDigest: digest, principalId }).problems;

// ---------------------------------------------------------------- positives
check("W01 exact web provisioning what-if is accepted", run(webWhatIf()).length === 0, run(webWhatIf()).join("; "));
check("W02 exact worker provisioning what-if is accepted", run(workerWhatIf(), "worker").length === 0, run(workerWhatIf(), "worker").join("; "));
check("W03 deployWeb=false what-if with no changes is accepted", run({ status: "Succeeded", changes: [] }, "web", false, undefined).length === 0);
check("W04 deployWeb=false what-if that would still create something is refused",
  run({ status: "Succeeded", changes: [{ resourceId: ids.webIdentity, changeType: "Create" }] }, "web", false, undefined).length > 0);

const mutate = (base, fn) => { const w = base(); fn(w); return w; };
const webApp = (w) => w.changes.find((c) => c.resourceId === ids.webApp).after;
const webEnv = (w) => webApp(w).properties.template.containers[0].env;
const job = (w) => w.changes.find((c) => c.resourceId === ids.workerJob).after;

// ---- Gate 008D hardening: principal binding (lead review 6899949127) --------------------------------------------
const WEB_PRINCIPAL = "9a9a9a9a-1b1b-4c2c-8d3d-4e4e4e4e4e4e";
const setPrincipal = (w, value, which = 1) => { w.changes[which].after.properties.principalId = value; };
const lit = (name) => `[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', '${name}'), '2023-01-31').principalId]`;
const fullId = (name) => `[reference('${ids.rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${name}', '2023-01-31').principalId]`;
{
  const w = webWhatIf(); for (let i = 1; i <= 4; i++) setPrincipal(w, WEB_PRINCIPAL, i);
  check("W05 concrete principal GUIDs equal to the supplied --principal-id are accepted", run(w, "web", true, DIGEST, p, WEB_PRINCIPAL).length === 0, run(w, "web", true, DIGEST, p, WEB_PRINCIPAL).join("; "));
  const l = webWhatIf(); for (let i = 1; i <= 4; i++) setPrincipal(l, lit(p.web.webIdentityName), i);
  check("W06 literal-name form for the intended identity is accepted", run(l).length === 0, run(l).join("; "));
  const f = webWhatIf(); for (let i = 1; i <= 4; i++) setPrincipal(f, fullId(p.web.webIdentityName), i);
  check("W07 full-resource-ID form for the intended identity is accepted", run(f).length === 0, run(f).join("; "));
  const ok = { resources: [0, 1].map(() => ({ type: "Microsoft.Authorization/roleAssignments", name: "x", properties: { principalType: "ServicePrincipal", principalId: COMPILED_PRINCIPAL("webIdentityName") } })) };
  const bad = structuredClone(ok); bad.resources[1].properties.principalId = COMPILED_PRINCIPAL("workerIdentityName");
  check("W08 compiled-drift check accepts the template's own identity and refuses another", checkCompiledPrincipals(ok, "webIdentityName").problems.length === 0 &&
    checkCompiledPrincipals(bad, "webIdentityName").problems.length === 1 && checkCompiledPrincipals({ resources: [] }, "webIdentityName").problems.length === 1);
}
const principalNegatives = [
  ["N46 web role assignment to another managed identity (literal name)", () => run(mutate(webWhatIf, (w) => setPrincipal(w, lit("id-cbc-other-cc-001"))))],
  ["N47 web role assignment to the legacy broad-vault identity", () => run(mutate(webWhatIf, (w) => setPrincipal(w, lit("id-cbc-web-cc-001"), 2)))],
  ["N48 web role assignment to the worker identity's parameter", () => run(mutate(webWhatIf, (w) => setPrincipal(w, COMPILED_PRINCIPAL("workerIdentityName"), 3)))],
  ["N49 worker role assignment bound to the web identity parameter (worker template declares webIdentityName too)", () => run(mutate(workerWhatIf, (w) => setPrincipal(w, COMPILED_PRINCIPAL("webIdentityName"))), "worker")],
  ["N50 arbitrary service-principal GUID with no supplied principal ID", () => run(mutate(webWhatIf, (w) => setPrincipal(w, "12345678-90ab-4cde-8f01-234567890abc")))],
  ["N51 service-principal GUID different from the supplied principal ID", () => run(mutate(webWhatIf, (w) => { for (let i = 1; i <= 4; i++) setPrincipal(w, WEB_PRINCIPAL, i); setPrincipal(w, "12345678-90ab-4cde-8f01-234567890abc", 4); }), "web", true, DIGEST, p, WEB_PRINCIPAL)],
  ["N52 lookalike expression wrapped in concat()", () => run(mutate(webWhatIf, (w) => setPrincipal(w, "[concat(reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', parameters('webIdentityName')), '2023-01-31').principalId, '')]")))],
  ["N53 lookalike expression with an extra resourceId segment", () => run(mutate(webWhatIf, (w) => setPrincipal(w, "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', parameters('webIdentityName'), 'x'), '2023-01-31').principalId]")))],
  ["N54 identity full resource ID of another identity", () => run(mutate(webWhatIf, (w) => setPrincipal(w, fullId("id-cbc-other-cc-001"))))],
  ["N55 full resource ID in another resource group with the same identity name", () => run(mutate(webWhatIf, (w) => setPrincipal(w, `[reference('/subscriptions/${p.subscriptionId}/resourceGroups/other-rg/providers/Microsoft.ManagedIdentity/userAssignedIdentities/${p.web.webIdentityName}', '2023-01-31').principalId]`)))],
  ["N56 missing principalId", () => run(mutate(webWhatIf, (w) => { delete w.changes[1].after.properties.principalId; }))],
  ["N57 principalType Group", () => run(mutate(webWhatIf, (w) => { w.changes[1].after.properties.principalType = "Group"; }))],
  ["N58 duplicate change for the same role-assignment resource ID", () => run(mutate(webWhatIf, (w) => { w.changes.push(structuredClone(w.changes[1])); }))],
  ["N59 duplicate change for the same app resource ID", () => run(mutate(webWhatIf, (w) => { w.changes.push({ resourceId: ids.webApp, changeType: "NoChange" }); }))],
  ["N60 supplied principal ID that is not a GUID", () => run(webWhatIf(), "web", true, DIGEST, p, "not-a-guid")],
  ["N61 valid expression followed by extra text", () => run(mutate(webWhatIf, (w) => setPrincipal(w, COMPILED_PRINCIPAL("webIdentityName") + "x")))],
  ["N62 valid expression preceded by extra text", () => run(mutate(webWhatIf, (w) => setPrincipal(w, "x" + COMPILED_PRINCIPAL("webIdentityName"))))],
];
for (const [name, fn] of principalNegatives) {
  let problems = [];
  let threw = null;
  try { problems = fn(); } catch (e) { threw = e; }
  // An exception is a broken test, never evidence of refusal.
  check(name + " -> refused", threw === null && problems.length > 0, threw ? "test threw: " + threw.message : "");
}

// ---------------------------------------------------------------- negatives (each must be refused)
const negatives = [
  ["N01 placeholder profile", () => checkWhatIf(repoProfile, webWhatIf(), { component: "web", enabled: true, imageDigest: DIGEST }).problems],
  ["N02 what-if status Failed", () => run(mutate(webWhatIf, (w) => { w.status = "Failed"; }))],
  ["N03 potential changes it could not evaluate", () => run(mutate(webWhatIf, (w) => { w.potentialChanges = [{ resourceId: ids.webApp }]; }))],
  ["N04 warning diagnostic", () => run(mutate(webWhatIf, (w) => { w.diagnostics.push({ level: "Warning", code: "X" }); }))],
  ["N05 Delete of the legacy staging app", () => run(mutate(webWhatIf, (w) => { w.changes.push({ resourceId: `${ids.rg}/providers/Microsoft.App/containerApps/ca-cbc-web-stg-cc-001`, changeType: "Delete" }); }))],
  ["N06 Modify of the existing Key Vault", () => run(mutate(webWhatIf, (w) => { w.changes.push({ resourceId: `${ids.rg}/providers/Microsoft.KeyVault/vaults/kv-cbc-prod-cc-001`, changeType: "Modify" }); }))],
  ["N07 Create of a protected existing name (legacy web identity)", () => run(mutate(webWhatIf, (w) => { w.changes.push({ resourceId: `${ids.rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-cbc-web-cc-001`, changeType: "Create" }); }))],
  ["N08 extra unexpected Create (second PostgreSQL server)", () => run(mutate(webWhatIf, (w) => { w.changes.push({ resourceId: `${ids.rg}/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg-cbc-new`, changeType: "Create" }); }))],
  ["N09 change in another resource group", () => run(mutate(webWhatIf, (w) => { w.changes.push({ resourceId: `/subscriptions/${p.subscriptionId}/resourceGroups/other-rg/providers/Microsoft.App/containerApps/x`, changeType: "NoChange" }); }))],
  ["N10 missing web Container App Create", () => run(mutate(webWhatIf, (w) => { w.changes = w.changes.filter((c) => c.resourceId !== ids.webApp); }))],
  ["N11 vault-wide Key Vault role instead of per-secret", () => run(mutate(webWhatIf, (w) => { w.changes[2] = role(`${ids.rg}/providers/Microsoft.KeyVault/vaults/kv-cbc-prod-cc-001`, ROLE.kvSecretsUser, 1); }))],
  ["N12 Owner role on the registry", () => run(mutate(webWhatIf, (w) => { w.changes[1] = role(ids.registry, "8e3af657-a8ff-443c-a75c-2fe8c4bcb635", 0); }))],
  ["N13 role assignment at resource-group scope", () => run(mutate(webWhatIf, (w) => { w.changes.push(role(ids.rg, ROLE.acrPull, 2)); }))],
  ["N14 duplicate state-secret role, missing cert role", () => run(mutate(webWhatIf, (w) => { w.changes[4] = role(ids.secret(p.web.oidcStateSecretName), ROLE.kvSecretsUser, 3); }))],
  ["N15 mutable image tag", () => run(mutate(webWhatIf, (w) => { webApp(w).properties.template.containers[0].image = `${p.existing.registryName}.azurecr.io/cbc-azure-web:latest`; }))],
  ["N16 image digest differs from the approved build", () => run(webWhatIf(), "web", true, "b".repeat(64))],
  ["N17 legacy image repository", () => run(mutate(webWhatIf, (w) => { webApp(w).properties.template.containers[0].image = `${p.existing.registryName}.azurecr.io/cbc-web@sha256:${DIGEST}`; }))],
  ["N18 Supabase service-role key injected", () => run(mutate(webWhatIf, (w) => { webEnv(w).push({ name: "SUPABASE_SERVICE_ROLE_KEY", secretRef: "x" }); }))],
  ["N19 Web Risk key reaches the web app", () => run(mutate(webWhatIf, (w) => { webEnv(w).push({ name: "GOOGLE_WEB_RISK_API_KEY", secretRef: "x" }); }))],
  ["N20 database URL with a password", () => run(mutate(webWhatIf, (w) => { webEnv(w).find((e) => e.name === "CBC_DATABASE_URL").value = `postgres://cbc_app:pw@${p.database.host}:5432/${p.database.name}`; }))],
  ["N21 database URL as an admin role", () => run(mutate(webWhatIf, (w) => { webEnv(w).find((e) => e.name === "CBC_DATABASE_URL").value = `postgres://cbcpgadmin@${p.database.host}:5432/${p.database.name}`; }))],
  ["N22 password database auth", () => run(mutate(webWhatIf, (w) => { webEnv(w).find((e) => e.name === "CBC_DATABASE_AUTH").value = "password"; }))],
  ["N23 OIDC state keys inline instead of Key Vault", () => run(mutate(webWhatIf, (w) => { const e = webEnv(w).find((x) => x.name === "CBC_AZURE_OIDC_STATE_KEYS"); delete e.secretRef; e.value = "k1:abc"; }))],
  ["N24 secret with an inline value", () => run(mutate(webWhatIf, (w) => { webApp(w).properties.configuration.secrets[0].value = "inline"; }))],
  ["N25 secret pointing at another vault secret", () => run(mutate(webWhatIf, (w) => { webApp(w).properties.configuration.secrets[1].keyVaultUrl = kvUrl("cbc-shared-google-web-risk-api-key"); }))],
  ["N26 public origin differs from the Entra registration", () => run(mutate(webWhatIf, (w) => { webEnv(w).find((e) => e.name === "CBC_AZURE_PUBLIC_ORIGIN").value = "https://evil.example"; }))],
  ["N27 insecure ingress", () => run(mutate(webWhatIf, (w) => { webApp(w).properties.configuration.ingress.allowInsecure = true; }))],
  ["N28 always-on replica", () => run(mutate(webWhatIf, (w) => { webApp(w).properties.template.scale.minReplicas = 1; }))],
  ["N29 legacy identity also assigned to the web app", () => run(mutate(webWhatIf, (w) => { webApp(w).identity.userAssignedIdentities[`${ids.rg}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/id-cbc-web-cc-001`] = {}; }))],
  ["N30 registry pull with an admin password", () => run(mutate(webWhatIf, (w) => { webApp(w).properties.configuration.registries[0].passwordSecretRef = "acr-pw"; }))],
  ["N31 secret material in the what-if output", () => run(mutate(webWhatIf, (w) => { w.changes[0].after = { note: "-----BEGIN RSA PRIVATE KEY-----" }; }))],
  ["N32 worker with platform retries", () => run(mutate(workerWhatIf, (w) => { job(w).properties.configuration.replicaRetryLimit = 3; }), "worker")],
  ["N33 worker with ingress", () => run(mutate(workerWhatIf, (w) => { job(w).properties.configuration.ingress = { external: true }; }), "worker")],
  ["N34 worker connecting as cbc_app", () => run(mutate(workerWhatIf, (w) => { job(w).properties.template.containers[0].env[0].value = `postgres://cbc_app@${p.database.host}:5432/${p.database.name}`; }), "worker")],
  ["N35 worker on a faster schedule than the profile", () => run(mutate(workerWhatIf, (w) => { job(w).properties.configuration.scheduleTriggerConfig.cronExpression = "*/5 * * * *"; }), "worker")],
  ["N36 worker Web Risk key inline", () => run(mutate(workerWhatIf, (w) => { const e = job(w).properties.template.containers[0].env[3]; delete e.secretRef; e.value = "AIza-not-real"; }), "worker")],
  ["N37 worker assigned the web identity", () => run(mutate(workerWhatIf, (w) => { job(w).identity.userAssignedIdentities = { [ids.webIdentity]: {} }; }), "worker")],
  ["N38 enabled without an approved digest", () => run(webWhatIf(), "web", true, null)],
];
for (const [name, fn] of negatives) {
  let problems = [];
  let threw = null;
  try { problems = fn(); } catch (e) { threw = e; }
  // An exception is a broken test, never evidence of refusal.
  check(name + " -> refused", threw === null && problems.length > 0, threw ? "test threw: " + threw.message : "");
}
// profile-level negatives
for (const [name, edit] of [
  ["N39 profile reuses the legacy web identity", (x) => { x.web.webIdentityName = "id-cbc-web-cc-001"; }],
  ["N40 profile web identity equals worker identity", (x) => { x.worker.workerIdentityName = x.web.webIdentityName; }],
  ["N41 profile with an always-on web replica", (x) => { x.web.minReplicas = 1; }],
  ["N42 profile containing a connection string with a password", (x) => { x.note = "postgres://cbc_app:secret@h/db"; }],
  ["N43 profile pointing the database at another server", (x) => { x.database.host = "other.postgres.database.azure.com"; }],
  ["N44 profile with a non-https public origin", (x) => { x.web.publicOrigin = "http://app.cbc.example"; }],
  ["N45 profile new app name colliding with the legacy app", (x) => { x.web.webAppName = "ca-cbc-web-stg-cc-001"; }],
]) {
  const x = clone(p); edit(x);
  check(name + " -> refused", validateProfile(x, { requireComplete: true }).length > 0);
}

// ================================================================ Gate 008E private network
{
  const netSrc = read("infra/azure/hosting/azure-private-network.bicep");
  const netParams = new Set([...netSrc.matchAll(/^param (\w+)/gm)].map((m) => m[1]));
  const profNet = Object.keys(repoProfile.network).filter((k) => !k.startsWith("_"));
  check("E01 every profile network field is a parameter of azure-private-network.bicep", profNet.every((k) => netParams.has(k)), profNet.filter((k) => !netParams.has(k)).join(","));
  for (const k of ["vnetAddressPrefix", "appsSubnetPrefix", "endpointSubnetPrefix"]) {
    check(`E02 Bicep default ${k} equals the profile value`, netSrc.includes(`param ${k} string = '${repoProfile.network[k]}'`));
  }
  check("E03 network template literals match the guard (subnet names, DNS zone, groupId, delegation)",
    netSrc.includes("var appsSubnetName = 'snet-cbc-aca'") && netSrc.includes("var endpointSubnetName = 'snet-cbc-pe'") &&
    netSrc.includes("'privatelink.postgres.database.azure.com'") && netSrc.includes("'postgresqlServer'") && netSrc.includes("serviceName: 'Microsoft.App/environments'") &&
    netSrc.includes("param deployNetwork bool = false"));
  const compiled = JSON.parse(read("scripts/azure-data/fixtures/azure-private-network.compiled.json"));
  check("E04 committed compiled network template passes the compiled check", checkCompiledNetwork(compiled).length === 0, checkCompiledNetwork(compiled).join("; "));
  const cres = (t) => (Array.isArray(t.resources) ? t.resources : Object.values(t.resources));
  for (const [name, edit] of [
    ["E05 deployNetwork defaulting to true", (t) => { t.parameters.deployNetwork.defaultValue = true; }],
    ["E06 an unconditional resource", (t) => { delete cres(t).find((r) => r.type === "Microsoft.Network/virtualNetworks").condition; }],
    ["E07 an added AllowAllAzure firewall rule", (t) => { cres(t).push({ type: "Microsoft.DBforPostgreSQL/flexibleServers/firewallRules", name: "x/AllowAllAzureServicesAndResourcesWithinAzureIps", condition: "[parameters('deployNetwork')]", properties: { startIpAddress: "0.0.0.0", endIpAddress: "0.0.0.0" } }); }],
    ["E08 an added public IP", (t) => { cres(t).push({ type: "Microsoft.Network/publicIPAddresses", name: "pip", condition: "[parameters('deployNetwork')]" }); }],
    ["E09 a Dedicated workload profile", (t) => { cres(t).find((r) => r.type === "Microsoft.App/managedEnvironments").properties.workloadProfiles.push({ name: "D4", workloadProfileType: "D4" }); }],
    ["E10 an internal-only environment", (t) => { cres(t).find((r) => r.type === "Microsoft.App/managedEnvironments").properties.vnetConfiguration.internal = true; }],
    ["E11 a wrong endpoint groupId", (t) => { const pe = cres(t).find((r) => r.type === "Microsoft.Network/privateEndpoints"); pe.properties.privateLinkServiceConnections[0].properties.groupIds = ["sqlServer"]; }],
    // Same resource set, forbidden content only: proves these checks independently of the exact-set check.
    ["E13 a 0.0.0.0/0 default address space", (t) => { t.parameters.vnetAddressPrefix.defaultValue = "0.0.0.0/0"; }],
    ["E14 a NAT gateway attached to a subnet", (t) => { cres(t).find((r) => r.type === "Microsoft.Network/virtualNetworks").properties.subnets[0].properties.natGateway = { id: "[resourceId('Microsoft.Network/natGateways', 'nat')]" }; }],
  ]) {
    const t = structuredClone(compiled); edit(t);
    check(name + " -> refused by the compiled check", checkCompiledNetwork(t).length > 0);
  }
  check("E12 CIDR parser rejects host addresses and accepts network addresses",
    parseCidr("10.80.0.5/24") === null && parseCidr("10.80.0.0/24")?.bits === 24 && parseCidr("10.80.0.128/28")?.start === parseCidr("10.80.0.0/24").start + 128);
}
const netAfter = {
  vnet: () => ({ properties: { addressSpace: { addressPrefixes: [p.network.vnetAddressPrefix] }, subnets: [
    { name: "snet-cbc-aca", properties: { addressPrefix: p.network.appsSubnetPrefix, delegations: [{ name: "container-apps", properties: { serviceName: "Microsoft.App/environments" } }] } },
    { name: "snet-cbc-pe", properties: { addressPrefix: p.network.endpointSubnetPrefix } },
  ] } }),
  dnsZone: () => ({ location: "global" }),
  dnsLink: () => ({ location: "global", properties: { registrationEnabled: false, virtualNetwork: { id: ids.vnet } } }),
  endpoint: () => ({ properties: { subnet: { id: ids.endpointSubnet }, privateLinkServiceConnections: [{ name: "postgres", properties: { privateLinkServiceId: ids.postgres, groupIds: ["postgresqlServer"] } }] } }),
  endpointDns: () => ({ properties: { privateDnsZoneConfigs: [{ name: "postgres", properties: { privateDnsZoneId: ids.dnsZone } }] } }),
  environment: () => ({ properties: { vnetConfiguration: { infrastructureSubnetId: ids.appsSubnet, internal: false }, workloadProfiles: [{ name: "Consumption", workloadProfileType: "Consumption" }],
    zoneRedundant: false, appLogsConfiguration: { destination: "log-analytics", logAnalyticsConfiguration: { customerId: "[reference('log').customerId]", sharedKey: "[listKeys('log').primarySharedKey]" } } } }),
};
const netWhatIf = () => ({ status: "Succeeded", potentialChanges: [], diagnostics: [], changes: [
  { resourceId: ids.vnet, changeType: "Create", after: netAfter.vnet() },
  { resourceId: ids.dnsZone, changeType: "Create", after: netAfter.dnsZone() },
  { resourceId: ids.dnsLink, changeType: "Create", after: netAfter.dnsLink() },
  { resourceId: ids.endpoint, changeType: "Create", after: netAfter.endpoint() },
  { resourceId: ids.endpointDns, changeType: "Create", after: netAfter.endpointDns() },
  { resourceId: ids.newEnvironment, changeType: "Create", after: netAfter.environment() },
  { resourceId: ids.postgres, changeType: "Ignore" },
  { resourceId: ids.existingEnvironment, changeType: "Ignore" },
] });
const nrun = (w, enabled = true) => checkWhatIf(p, w, { component: "network", enabled }).problems;
const at = (w, id) => w.changes.find((c) => c.resourceId === id).after;
check("NW01 exact private-network what-if is accepted", nrun(netWhatIf()).length === 0, nrun(netWhatIf()).join("; "));
check("NW02 deployNetwork=false what-if with no changes is accepted", nrun({ status: "Succeeded", changes: [] }, false).length === 0);
const netNegatives = [
  ["NN01 AllowAllAzure firewall rule (0.0.0.0) on the existing server", () => nrun(mutate(netWhatIf, (w) => { w.changes.push({ resourceId: `${ids.postgres}/firewallRules/AllowAllAzureServicesAndResourcesWithinAzureIps`, changeType: "Create", after: { properties: { startIpAddress: "0.0.0.0", endIpAddress: "0.0.0.0" } } }); }))],
  ["NN02 Modify of the existing PostgreSQL server", () => nrun(mutate(netWhatIf, (w) => { w.changes.find((c) => c.resourceId === ids.postgres).changeType = "Modify"; }))],
  ["NN03 Modify of the existing Container Apps environment", () => nrun(mutate(netWhatIf, (w) => { w.changes.find((c) => c.resourceId === ids.existingEnvironment).changeType = "Modify"; }))],
  ["NN04 private endpoint to another server", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.endpoint).properties.privateLinkServiceConnections[0].properties.privateLinkServiceId = `${ids.rg}/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg-other`; }))],
  ["NN05 private endpoint with the wrong groupId", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.endpoint).properties.privateLinkServiceConnections[0].properties.groupIds = ["sqlServer"]; }))],
  ["NN06 private endpoint placed in the Container Apps subnet", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.endpoint).properties.subnet.id = ids.appsSubnet; }))],
  ["NN07 manual (unapproved) private link connection", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.endpoint).properties.manualPrivateLinkServiceConnections = [{}]; }))],
  ["NN08 Dedicated workload profile (management charge)", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.newEnvironment).properties.workloadProfiles.push({ name: "D4", workloadProfileType: "D4" }); }))],
  ["NN09 internal-only environment (website unreachable)", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.newEnvironment).properties.vnetConfiguration.internal = true; }))],
  ["NN10 environment in the endpoint subnet", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.newEnvironment).properties.vnetConfiguration.infrastructureSubnetId = ids.endpointSubnet; }))],
  ["NN11 zone-redundant environment (unapproved cost)", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.newEnvironment).properties.zoneRedundant = true; }))],
  ["NN12 virtual network peering", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.vnet).properties.virtualNetworkPeerings = [{ name: "to-elsewhere" }]; }))],
  ["NN13 Container Apps subnet without delegation", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.vnet).properties.subnets[0].properties.delegations = []; }))],
  ["NN14 extra subnet", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.vnet).properties.subnets.push({ name: "snet-extra", properties: { addressPrefix: "10.80.0.160/28" } }); }))],
  ["NN15 different address space", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.vnet).properties.addressSpace.addressPrefixes = ["10.0.0.0/16"]; }))],
  ["NN16 NAT gateway attached to a subnet", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.vnet).properties.subnets[0].properties.natGateway = { id: "nat" }; }))],
  ["NN17 DDoS protection plan", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.vnet).properties.enableDdosProtection = true; }))],
  ["NN18 DNS zone linked to another network", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.dnsLink).properties.virtualNetwork.id = `${ids.rg}/providers/Microsoft.Network/virtualNetworks/other`; }))],
  ["NN19 DNS auto-registration enabled", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.dnsLink).properties.registrationEnabled = true; }))],
  ["NN20 endpoint registered in another DNS zone", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.endpointDns).properties.privateDnsZoneConfigs[0].properties.privateDnsZoneId = `${ids.rg}/providers/Microsoft.Network/privateDnsZones/privatelink.database.windows.net`; }))],
  ["NN21 public IP created", () => nrun(mutate(netWhatIf, (w) => { w.changes.push({ resourceId: `${ids.rg}/providers/Microsoft.Network/publicIPAddresses/pip-cbc`, changeType: "Create" }); }))],
  ["NN22 duplicate virtual network change", () => nrun(mutate(netWhatIf, (w) => { w.changes.push(structuredClone(w.changes[0])); }))],
  ["NN23 missing private endpoint", () => nrun(mutate(netWhatIf, (w) => { w.changes = w.changes.filter((c) => c.resourceId !== ids.endpoint); }))],
  ["NN24 disabled network that still creates something", () => nrun({ status: "Succeeded", changes: [{ resourceId: ids.vnet, changeType: "Create", after: netAfter.vnet() }] }, false)],
  ["NN25 workspace key in clear in the what-if", () => nrun(mutate(netWhatIf, (w) => { at(w, ids.newEnvironment).properties.appLogsConfiguration.logAnalyticsConfiguration.sharedKey = "c2VjcmV0LWtleS12YWx1ZQ=="; }))],
  ["NN26 web app deployed into the EXISTING environment", () => run(mutate(webWhatIf, (w) => { webApp(w).properties.managedEnvironmentId = ids.existingEnvironment; }))],
  ["NN27 worker job deployed into the EXISTING environment", () => run(mutate(workerWhatIf, (w) => { job(w).properties.environmentId = ids.existingEnvironment; }), "worker")],
];
for (const [name, fn] of netNegatives) {
  let problems = [];
  let threw = null;
  try { problems = fn(); } catch (e) { threw = e; }
  check(name + " -> refused", threw === null && problems.length > 0, threw ? "test threw: " + threw.message : "");
}
for (const [name, edit] of [
  ["NP01 network environment equal to the existing environment", (x) => { x.network.environmentName = x.existing.environmentName; }],
  ["NP02 Container Apps subnet smaller than /27", (x) => { x.network.appsSubnetPrefix = "10.80.0.0/28"; }],
  ["NP03 overlapping subnets", (x) => { x.network.endpointSubnetPrefix = "10.80.0.64/28"; }],
  ["NP04 subnet outside the virtual network", (x) => { x.network.endpointSubnetPrefix = "10.81.0.0/28"; }],
  ["NP05 public (non-RFC 1918) address space", (x) => { x.network.vnetAddressPrefix = "20.80.0.0/24"; x.network.appsSubnetPrefix = "20.80.0.0/25"; x.network.endpointSubnetPrefix = "20.80.0.128/28"; }],
  ["NP06 host address instead of a network address", (x) => { x.network.vnetAddressPrefix = "10.80.0.5/24"; }],
  ["NP07 missing network section", (x) => { delete x.network; }],
  ["NP08 invalid endpoint name", (x) => { x.network.privateEndpointName = "PE CBC"; }],
]) {
  const x = clone(p); edit(x);
  check(name + " -> refused", validateProfile(x, { requireComplete: true }).length > 0);
}

console.log(`\n=== Gate 008D clean-start what-if guard: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
