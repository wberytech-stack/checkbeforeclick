/** Offline Azure PostgreSQL TLS safety tests. No network, secrets or database. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getPgConnectionOptions } from "../../src/server/db/pgTls.ts";

let passed = 0;
function check(name, test) {
  test();
  passed++;
  console.log("PASS: " + name);
}
const remote = "postgresql://cbc_app:example-only@db.example.com:5432/cbc";

check("remote connections verify TLS certificate and hostname", () => {
  const result = getPgConnectionOptions(remote, undefined);
  assert.deepEqual(result.ssl, { rejectUnauthorized: true });
  assert.equal(result.connectionString, remote);
});
check("sslmode=require cannot override certificate verification", () => {
  const result = getPgConnectionOptions(remote + "?sslmode=require", undefined);
  assert.deepEqual(result.ssl, { rejectUnauthorized: true });
  assert.equal(result.connectionString, remote);
});
check("sslmode=verify-full is accepted with verified TLS", () => {
  const result = getPgConnectionOptions(remote + "?sslmode=verify-full", undefined);
  assert.deepEqual(result.ssl, { rejectUnauthorized: true });
  assert.equal(result.connectionString, remote);
});
check("local disposable PostgreSQL may explicitly disable TLS", () => {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const result = getPgConnectionOptions("postgresql://cbc_app:example-only@" + host + ":55433/cbc", "false");
    assert.equal(result.ssl, false);
  }
});
check("local connections use verified TLS by default", () => {
  assert.deepEqual(getPgConnectionOptions("postgresql://localhost/cbc", undefined).ssl, { rejectUnauthorized: true });
});
check("non-loopback TLS opt-out is refused", () => {
  for (const host of ["db.example.com", "localhost.evil.test", "10.0.0.1", "0.0.0.0"]) {
    assert.throws(() => getPgConnectionOptions("postgresql://cbc_app:example-only@" + host + "/cbc", "false"), /loopback/);
  }
});
check("unsafe SSL modes and override parameters are refused", () => {
  for (const option of ["sslmode=disable", "sslmode=no-verify", "sslmode=prefer", "sslmode=verify-ca", "sslcert=%2Ftmp%2Fcert", "host=localhost", "sslmode=require&sslmode=disable", "sslmode=require&application_name=x", "SSLMode=require"]) {
    assert.throws(() => getPgConnectionOptions(remote + "?" + option, undefined), /unsupported/);
  }
});
check("invalid URLs are refused without exposing credentials", () => {
  for (const url of [undefined, "not a url", "https://db.example.com", "postgresql://", remote + "#secret"]) {
    assert.throws(() => getPgConnectionOptions(url, undefined));
    try {
      getPgConnectionOptions(url, undefined);
    } catch (error) {
      assert.doesNotMatch(String(error), /example-only|secret/);
    }
  }
});
check("runtime pool uses the audited TLS options", () => {
  const source = readFileSync(new URL("../../src/server/db/postgres.ts", import.meta.url), "utf8");
  assert.match(source, /getPgConnectionOptions\(getDatabaseUrl\(\), process\.env\.CBC_DATABASE_SSL\)/);
  assert.doesNotMatch(source, /rejectUnauthorized\s*:\s*false/);
});
console.log("PASS: " + passed + " offline PostgreSQL TLS checks");
