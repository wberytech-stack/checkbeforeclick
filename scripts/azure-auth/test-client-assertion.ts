/** Offline Entra confidential-client assertion tests; ephemeral local test certificate only. */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, verify, constants, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAzureClientAssertion } from "../../src/server/auth/azureClientAssertion.ts";

const dir = mkdtempSync(join(tmpdir(), "cbc-client-assertion-"));
const endpoint = "https://tenant.ciamlogin.com/tenant/oauth2/v2.0/token";
const clientId = "cbc-client";
let now = Date.now();
let passed = 0;
let input: Parameters<typeof createAzureClientAssertion>[0];
function check(label: string, action: () => void) { action(); passed++; console.log("PASS", label); }
function denied(label: string, changes: object) {
  check(label, () => assert.throws(() => createAzureClientAssertion({ ...input, ...changes }),
    (error: unknown) => error instanceof Error && error.message === "Azure client authentication unavailable"));
}
try {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const keyPath = join(dir, "key.pem"), certPath = join(dir, "cert.pem");
  writeFileSync(keyPath, pem, { mode: 0o600 });
  execFileSync("openssl", ["req", "-new", "-x509", "-key", keyPath, "-out", certPath,
    "-subj", "/CN=cbc-offline-test", "-days", "2"], { stdio: "ignore" });
  const certPem = readFileSync(certPath, "utf8");
  const cert = new X509Certificate(certPem);
  // Certificate creation can cross a second boundary after the test starts.
  // Use a clock after issuance so validFrom is not accidentally in the future.
  now = Date.now() + 1000;
  input = { clientId, tokenEndpoint: endpoint, privateKeyPemBase64: Buffer.from(pem).toString("base64"),
    certificatePemBase64: Buffer.from(certPem).toString("base64"), now: () => now };
  check("C01 PS256 signature and certificate thumbprint", () => {
    const assertion = createAzureClientAssertion(input);
    const [head, body, signature] = assertion.split(".");
    const header = JSON.parse(Buffer.from(head, "base64url").toString("utf8"));
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    assert.equal(header.alg, "PS256");
    assert.equal(header["x5t#S256"], createHash("sha256").update(cert.raw).digest("base64url"));
    assert.equal(claims.aud, endpoint);
    assert.equal(claims.iss, clientId);
    assert.equal(claims.sub, clientId);
    assert.equal(claims.exp - claims.iat, 300);
    assert.ok(verify("sha256", Buffer.from(head + "." + body), {
      key: cert.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    }, Buffer.from(signature, "base64url")));
  });
  check("C02 every assertion uses a unique jti", () => {
    const payload = () => JSON.parse(Buffer.from(createAzureClientAssertion(input).split(".")[1], "base64url").toString("utf8"));
    assert.notEqual(payload().jti, payload().jti);
  });
  denied("C03 missing key fails closed", { privateKeyPemBase64: undefined });
  denied("C04 missing certificate fails closed", { certificatePemBase64: undefined });
  denied("C05 invalid key fails closed", { privateKeyPemBase64: "a" });
  denied("C06 malformed certificate fails closed", { certificatePemBase64: "YWJj" });
  denied("C07 insecure token endpoint rejected", { tokenEndpoint: endpoint.replace("https:", "http:") });
  denied("C08 query endpoint rejected", { tokenEndpoint: endpoint + "?next=evil" });
  denied("C09 invalid client ID rejected", { clientId: "bad\r\nclient" });
  denied("C10 certificate expiration margin enforced", { now: () => now + 3 * 86400_000 });
  denied("C11 certificate not yet valid denied", { now: () => now - 86400_000 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  denied("C12 mismatched private key rejected", { privateKeyPemBase64: Buffer.from(
    other.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64") });
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
  denied("C13 non-RSA private key rejected", { privateKeyPemBase64: Buffer.from(
    ec.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64") });
  denied("C14 oversized secret rejected", { privateKeyPemBase64: "A".repeat(20000) });
  console.log("Azure client assertion: " + passed + " offline assertions passed");
} finally { rmSync(dir, { recursive: true, force: true }); }
