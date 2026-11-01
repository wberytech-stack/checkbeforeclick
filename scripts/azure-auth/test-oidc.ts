// Gate 008B: pure, offline security tests. No network, secrets, Azure or database.
// Run: node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/azure-auth/test-oidc.ts
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createLoginChallenge, verifyCallbackState, verifyIdToken, OidcValidationError, type RsaJwk } from "../../src/security/azureOidc.ts";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`PASS ${label}`); }
  else { failed++; console.log(`FAIL ${label}`); }
}
function rejects(label: string, fn: () => unknown) {
  let correct = false;
  try { fn(); } catch (error) { correct = error instanceof OidcValidationError; }
  check(label, correct);
}

const ISSUER = "https://cbc-test.ciamlogin.com/tenant-id/v2.0";
const CLIENT = "cbc-client-id";
const NONCE = "test-nonce-that-cannot-be-reused";
const NOW = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: "jwk" }) as JsonWebKey), kid: "key-1", alg: "RS256", use: "sig" } as RsaJwk;
const base = { iss: ISSUER, aud: CLIENT, sub: "opaque-entra-subject", nonce: NONCE, exp: NOW + 3600, iat: NOW, email: "not-verified@example.invalid", name: "Test User" };
function jwt(claims: Record<string, unknown> = base, header: Record<string, unknown> = { alg: "RS256", kid: "key-1", typ: "JWT" }, key = privateKey) {
  const h = Buffer.from(JSON.stringify(header)).toString("base64url");
  const p = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url");
  return `${h}.${p}.${s}`;
}
function validate(overrides: Record<string, unknown> = {}) {
  return verifyIdToken({ token: jwt(), jwks: { keys: [jwk] }, issuer: ISSUER, audience: CLIENT, nonce: NONCE, nowSeconds: NOW, ...overrides });
}
function badClaims(label: string, patch: Record<string, unknown>) {
  rejects(label, () => validate({ token: jwt({ ...base, ...patch }) }));
}

// OAuth authorization request: PKCE S256, independent state/nonce, fixed endpoints and redirect.
const settings = { issuer: ISSUER, clientId: CLIENT, authorizationEndpoint: "https://cbc-test.ciamlogin.com/tenant-id/oauth2/v2.0/authorize", redirectUri: "https://app.example.com/auth/callback" };
const c = createLoginChallenge(settings);
const u = new URL(c.authorizationUrl);
check("A01 response_type code only", u.searchParams.get("response_type") === "code");
check("A02 PKCE S256 challenge matches verifier", u.searchParams.get("code_challenge_method") === "S256" && u.searchParams.get("code_challenge") === createHash("sha256").update(c.codeVerifier).digest("base64url"));
check("A03 state and nonce independent 256-bit values", c.state.length === 43 && c.nonce.length === 43 && c.state !== c.nonce && c.codeVerifier !== c.state);
check("A04 authorization URI is fixed and uses expected client and redirect", u.origin === "https://cbc-test.ciamlogin.com" && u.searchParams.get("client_id") === CLIENT && u.searchParams.get("redirect_uri") === settings.redirectUri);
check("A05 scopes include openid and no implicit response", u.searchParams.get("scope")?.includes("openid") === true && u.searchParams.get("response_mode") === "query");
check("A06 fresh login uses fresh state", createLoginChallenge(settings).state !== c.state);
verifyCallbackState(c.state, c.state);
check("A07 matching callback state accepted", true);
rejects("A08 callback state mismatch rejected", () => verifyCallbackState("wrong", c.state));
rejects("A09 callback state absent rejected", () => verifyCallbackState(null, c.state));
rejects("A10 authorization endpoint cannot be remote", () => createLoginChallenge({ ...settings, authorizationEndpoint: "https://attacker.invalid/authorize" }));
rejects("A11 authorization endpoint cannot contain query", () => createLoginChallenge({ ...settings, authorizationEndpoint: settings.authorizationEndpoint + "?x=1" }));
rejects("A12 redirect cannot be HTTP", () => createLoginChallenge({ ...settings, redirectUri: "http://app.example.com/auth/callback" }));
rejects("A13 redirect cannot include attacker query", () => createLoginChallenge({ ...settings, redirectUri: settings.redirectUri + "?next=https://evil.invalid" }));
rejects("A14 issuer cannot contain credentials", () => createLoginChallenge({ ...settings, issuer: "https://user:pass@cbc-test.ciamlogin.com/tenant-id/v2.0" }));
rejects("A15 scope must include openid", () => createLoginChallenge({ ...settings, scope: "profile email" }));
rejects("A16 random source must return requested bytes", () => createLoginChallenge(settings, () => Buffer.alloc(2)));

// OIDC JWT: signature, issuer, audience, nonce, time, key policy and subject.
const identity = validate();
check("J01 valid RS256 ID token accepted", identity.issuer === ISSUER && identity.subject === base.sub && identity.email === base.email);
check("J02 display name is informational", identity.displayName === base.name);
check("J03 missing email is allowed (never account key)", verifyIdToken({ token: jwt({ ...base, email: undefined }), jwks: { keys: [jwk] }, issuer: ISSUER, audience: CLIENT, nonce: NONCE, nowSeconds: NOW }).email === null);
rejects("J04 alg none rejected", () => validate({ token: jwt(base, { alg: "none", kid: "key-1" }) }));
rejects("J05 HS256 algorithm confusion rejected", () => validate({ token: jwt(base, { alg: "HS256", kid: "key-1" }) }));
rejects("J06 critical headers rejected", () => validate({ token: jwt(base, { alg: "RS256", kid: "key-1", crit: ["foo"] }) }));
rejects("J07 unknown kid rejected", () => validate({ token: jwt(base, { alg: "RS256", kid: "unknown" }) }));
rejects("J08 duplicate kid rejected", () => validate({ jwks: { keys: [jwk, jwk] } }));
rejects("J09 JWKS key for encryption rejected", () => validate({ jwks: { keys: [{ ...jwk, use: "enc" }] } }));
rejects("J10 JWKS key for signing only rejected", () => validate({ jwks: { keys: [{ ...jwk, key_ops: ["sign"] }] } }));
rejects("J11 non-RSA key rejected", () => validate({ jwks: { keys: [{ ...jwk, kty: "oct" }] } }));
const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
rejects("J12 wrong signing key rejected", () => validate({ token: jwt(base, undefined, wrong) }));
rejects("J13 tampered payload rejected", () => { const [h, , sig] = jwt().split("."); return validate({ token: `${h}.${Buffer.from(JSON.stringify({ ...base, sub: "tampered" })).toString("base64url")}.${sig}` }); });
badClaims("J14 wrong issuer rejected", { iss: "https://attacker.invalid/tenant" });
badClaims("J15 wrong audience rejected", { aud: "another-client" });
badClaims("J16 multiple audiences without azp rejected", { aud: [CLIENT, "other-client"] });
badClaims("J17 azp mismatch rejected", { aud: [CLIENT, "other-client"], azp: "other-client" });
check("J18 multiple audiences with correct azp accepted", verifyIdToken({ token: jwt({ ...base, aud: [CLIENT, "other-client"], azp: CLIENT }), jwks: { keys: [jwk] }, issuer: ISSUER, audience: CLIENT, nonce: NONCE, nowSeconds: NOW }).subject === base.sub);
badClaims("J19 nonce mismatch rejected", { nonce: "attacker-nonce" });
badClaims("J20 missing nonce rejected", { nonce: undefined });
badClaims("J21 expired token rejected", { exp: NOW - 120 });
badClaims("J22 token not yet valid rejected", { nbf: NOW + 120 });
badClaims("J23 future iat rejected", { iat: NOW + 120 });
badClaims("J24 long-lived token rejected", { exp: NOW + 7201 });
badClaims("J25 missing subject rejected", { sub: undefined });
badClaims("J26 numeric expiry rejected", { exp: "1800003600" });
badClaims("J27 fractional iat rejected", { iat: NOW + 0.5 });
rejects("J28 missing token rejected", () => validate({ token: "" }));
rejects("J29 JWT with extra segment rejected", () => validate({ token: jwt() + ".extra" }));
rejects("J30 JWT with malformed JSON rejected", () => validate({ token: `e30.${Buffer.from("not json").toString("base64url")}.x` }));
rejects("J31 oversized token rejected", () => validate({ token: "a".repeat(20_000) }));
rejects("J32 noncanonical encoding rejected", () => validate({ token: jwt().replace(/-/g, "+") }));
check("J33 invalid email is never used for linking", verifyIdToken({ token: jwt({ ...base, email: null }), jwks: { keys: [jwk] }, issuer: ISSUER, audience: CLIENT, nonce: NONCE, nowSeconds: NOW }).email === null);
console.log(`\n=== Gate 008B OIDC foundation: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
