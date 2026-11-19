import assert from "node:assert/strict";
import { AZURE_THEME_STORAGE_KEY, parseAzureThemePreference, resolveAzureDarkTheme } from "../../src/client/azureTheme.ts";

let checks = 0;
function check(name: string, fn: () => void) {
  fn();
  checks++;
  console.log("PASS", name);
}
check("theme preference has a stable storage key", () => assert.equal(AZURE_THEME_STORAGE_KEY, "cbc.security-center.theme"));
for (const preference of ["light", "dark", "system"] as const) {
  check(`accept persisted ${preference} preference`, () => assert.equal(parseAzureThemePreference(preference), preference));
}
for (const invalid of [null, "", "auto", "Dark", "SYSTEM", "undefined", "false", "<script>"]) {
  check(`invalid preference falls back to system: ${String(invalid)}`, () => assert.equal(parseAzureThemePreference(invalid), "system"));
}
for (const systemDark of [false, true]) {
  check(`explicit light overrides system ${systemDark}`, () => assert.equal(resolveAzureDarkTheme("light", systemDark), false));
  check(`explicit dark overrides system ${systemDark}`, () => assert.equal(resolveAzureDarkTheme("dark", systemDark), true));
  check(`system tracks OS ${systemDark}`, () => assert.equal(resolveAzureDarkTheme("system", systemDark), systemDark));
}
console.log(`Azure appearance preferences: ${checks} offline assertions passed`);
