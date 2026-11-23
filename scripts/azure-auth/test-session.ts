/** Gate 008B: offline opaque session token and cookie tests; no network or database. */
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { AZURE_SESSION_COOKIE_NAME, AZURE_SESSION_TTL_SECONDS, AzureSessionError,
  azureSessionClearCookie, azureSessionSetCookie, createUnpersistedAzureSessionToken,
  digestAzureSessionToken, readAzureSessionToken } from "../../src/security/azureSession.ts";

let passed = 0; let failed = 0;
function check(name: string, run: () => void) {
  try { run(); passed++; console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}: ${String(error)}`); }
}
const { token, digest } = createUnpersistedAzureSessionToken();
const other = createUnpersistedAzureSessionToken();
const cookie = azureSessionSetCookie(token);
const header = `theme=dark; ${AZURE_SESSION_COOKIE_NAME}=${token}; locale=en`;
check("P01 token has 256 bits of entropy in canonical base64url", () => {
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(token, "base64url").length, 32);
  assert.equal(Buffer.from(token, "base64url").toString("base64url"), token);
});
check("P02 independently generated tokens differ", () => assert.notEqual(token, other.token));
check("P03 digests differ", () => assert.notEqual(digest, other.digest));
check("P04 digest is 64 lowercase hex characters", () => assert.match(digest, /^[0-9a-f]{64}$/));
check("P05 digest is deterministic", () => assert.equal(digestAzureSessionToken(token), digest));
check("P06 digest is purpose-separated from ordinary SHA256", () => {
  assert.notEqual(digest, createHash("sha256").update(token).digest("hex"));
});
check("P07 digest does not contain raw token", () => assert.ok(!digest.includes(token)));
check("P08 cookie uses __Host- prefix", () => assert.ok(AZURE_SESSION_COOKIE_NAME.startsWith("__Host-")));
check("P09 cookie is host-only and root scoped", () => {
  assert.ok(cookie.includes("Path=/;")); assert.ok(!cookie.includes("Domain="));
});
check("P10 cookie is HttpOnly and Secure", () => {
  assert.ok(cookie.includes("HttpOnly")); assert.ok(cookie.includes("Secure"));
});
check("P11 cookie uses SameSite=Lax", () => assert.ok(cookie.includes("SameSite=Lax")));
check("P12 cookie has bounded 12-hour lifetime", () => {
  assert.equal(AZURE_SESSION_TTL_SECONDS, 43200); assert.ok(cookie.includes("Max-Age=43200"));
});
check("P13 cookie clear matches exact name and root path", () => {
  assert.equal(azureSessionClearCookie(), `${AZURE_SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
});
check("P14 valid header with other cookies resolves", () => assert.equal(readAzureSessionToken(header), token));
check("P15 session cookie alone resolves", () => assert.equal(readAzureSessionToken(`${AZURE_SESSION_COOKIE_NAME}=${token}`), token));
check("P16 absent cookie returns null", () => assert.equal(readAzureSessionToken("theme=dark"), null));
check("P17 empty cookie header returns null", () => assert.equal(readAzureSessionToken(""), null));
check("P18 null header returns null", () => assert.equal(readAzureSessionToken(null), null));
check("P19 duplicate identical cookies denied", () => assert.equal(readAzureSessionToken(`${header}; ${AZURE_SESSION_COOKIE_NAME}=${token}`), null));
check("P20 duplicate conflicting cookies denied", () => assert.equal(readAzureSessionToken(`${header}; ${AZURE_SESSION_COOKIE_NAME}=${other.token}`), null));
check("P21 invalid first cookie cannot be overridden", () => assert.equal(readAzureSessionToken(`${AZURE_SESSION_COOKIE_NAME}=bad; ${AZURE_SESSION_COOKIE_NAME}=${token}`), null));
check("P22 URL-encoded token denied", () => assert.equal(readAzureSessionToken(`${AZURE_SESSION_COOKIE_NAME}=%${token}`), null));
check("P23 quoted token denied", () => assert.equal(readAzureSessionToken(`${AZURE_SESSION_COOKIE_NAME}="${token}"`), null));
check("P24 padded token denied", () => assert.equal(digestAzureSessionToken(token + "="), null));
check("P25 token with whitespace denied", () => assert.equal(digestAzureSessionToken(token + " "), null));
check("P26 token with newline denied", () => assert.equal(digestAzureSessionToken(token + "\n"), null));
check("P27 token with CRLF header denied", () => assert.equal(readAzureSessionToken(header + "\r\nX: y"), null));
check("P28 oversized cookie header denied", () => assert.equal(readAzureSessionToken(header + "x".repeat(8192)), null));
check("P29 non-string cookie header denied", () => assert.equal(readAzureSessionToken({}), null));
check("P30 malformed base64url pad bits denied", () => {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const last = chars.indexOf(token[42]);
  const changed = token.slice(0, 42) + chars[(last & 0x30) | ((last + 1) & 0x0f)];
  assert.notEqual(changed, token);
  assert.equal(digestAzureSessionToken(changed), null);
});
check("P31 malformed token rejected by cookie setter", () => assert.throws(() => azureSessionSetCookie("x"), AzureSessionError));
check("P32 cookie header injection rejected by setter", () => assert.throws(() => azureSessionSetCookie(token + "\r\nSet-Cookie:bad=1"), AzureSessionError));
check("P33 invalid token input types denied", () => {
  for (const v of [undefined, null, {}, 123, false, [], ""]) assert.equal(digestAzureSessionToken(v), null);
});
check("P34 clear cookie does not depend on a valid session", () => assert.ok(azureSessionClearCookie().includes("Max-Age=0")));
console.log(`\n=== Gate 008B opaque session credentials: ${passed} passed, ${failed} failed ===`);
process.exitCode = failed ? 1 : 0;
