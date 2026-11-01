// Gate 007A - offline static checks for the public.users tenant-pointer guard (draft migration 002) and for how the
// application resolves a user's organization. No network, no database, no new dependency. The behavioral check of
// the migration is scripts/rate-limit/validate-users-guard-db.ts (disposable database; not yet run).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/test-tenant-guard.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}
const root = path.resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(path.join(root, p), "utf8");

const sql = read("infra/supabase/migrations/002_users_identity_guard.sql");
const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const down = read("infra/supabase/migrations/002_users_identity_guard.down.sql");

check("G01 marked DRAFT, not applied, founder-only", /DRAFT MIGRATION\. NOT applied to any database/.test(sql) && /founder-only/.test(sql));
check("G02 guard function is NOT security definer (current_user must be the caller)", !/SECURITY DEFINER/i.test(code));
check("G03 guard function pins search_path", /SET search_path = pg_catalog, public/.test(code));
check("G04 applies to the PostgREST roles anon and authenticated", /current_user IN \('anon', 'authenticated'\)/.test(code));
check("G05 blocks INSERT and DELETE for those roles", /TG_OP = 'INSERT' OR TG_OP = 'DELETE'/.test(code));
check("G06 blocks changes to id, organization_id and role",
  /NEW\.id IS DISTINCT FROM OLD\.id/.test(code) && /NEW\.organization_id IS DISTINCT FROM OLD\.organization_id/.test(code) && /NEW\.role IS DISTINCT FROM OLD\.role/.test(code));
check("G07 raises insufficient_privilege (42501)", (code.match(/ERRCODE = '42501'/g) ?? []).length === 2);
check("G08 BEFORE INSERT OR UPDATE OR DELETE, FOR EACH ROW on public.users",
  /CREATE TRIGGER cbc_guard_users_identity\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.users\s+FOR EACH ROW EXECUTE FUNCTION public\.cbc_guard_users_identity\(\);/.test(code));
check("G09 idempotent (CREATE OR REPLACE function, DROP TRIGGER IF EXISTS)", /CREATE OR REPLACE FUNCTION public\.cbc_guard_users_identity\(\)/.test(code) && /DROP TRIGGER IF EXISTS cbc_guard_users_identity ON public\.users;/.test(code));
check("G10 function not executable by PUBLIC, anon or authenticated", /REVOKE ALL ON FUNCTION public\.cbc_guard_users_identity\(\) FROM PUBLIC;/.test(code) && /REVOKE ALL ON FUNCTION public\.cbc_guard_users_identity\(\) FROM anon, authenticated;/.test(code));
check("G11 changes no policy, grant on a table, or data", !/CREATE POLICY|DROP POLICY|ALTER POLICY|GRANT .* ON TABLE|REVOKE .* ON TABLE|INSERT INTO|UPDATE public|DELETE FROM/i.test(code));
check("G12 down migration drops exactly the trigger and the function",
  /DROP TRIGGER IF EXISTS cbc_guard_users_identity ON public\.users;/.test(down) && /DROP FUNCTION IF EXISTS public\.cbc_guard_users_identity\(\);/.test(down)
  && down.split("\n").filter((l) => l.trim() && !l.trim().startsWith("--")).length === 2);
check("G13 migration 001 is unchanged by this work (still the only admission migration)", /CREATE OR REPLACE FUNCTION public\.cbc_admit_scan\(p_input_type text\)/.test(read("infra/supabase/migrations/001_scan_admission.sql")));

// ---- how the application resolves the tenant ---------------------------------------------------------------------
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full);
    else if (/\.(ts|tsx)$/.test(name)) files.push(full);
  }
};
for (const d of ["app", "lib", "components", "src", "inngest"]) walk(path.join(root, d));
files.push(path.join(root, "proxy.ts"));
const appFiles = files;
const rel = (f: string) => path.relative(root, f).split(path.sep).join("/");
const src = (f: string) => readFileSync(f, "utf8");

const usersTouch = appFiles.filter((f) => /from\(\s*["'](users|organizations)["']\s*\)/.test(src(f))).map(rel).sort();
check("A01 only lib/data/index.ts touches public.users or public.organizations", [...new Set(usersTouch)].join(",") === "lib/data/index.ts", usersTouch.join(","));
const data = read("lib/data/index.ts");
const usersQuery = data.slice(data.indexOf('.from("users")'), data.indexOf(".single()", data.indexOf('.from("users")')));
check("A02 the users table is only read (select ... eq id), never written by the app", /\.select\("id, organization_id, role, full_name"\)\s*\.eq\("id", authUserId\)/.test(usersQuery) && !/\.(update|upsert|insert|delete)\(/.test(usersQuery));
check("A03 no app code writes users/organizations through any client", !appFiles.some((f) => /from\(\s*["'](users|organizations)["']\s*\)\s*\.(update|upsert|insert|delete)\(/.test(src(f))));
check("A04 no app code reads user_metadata / raw_user_meta_data for authorization", !appFiles.some((f) => /user_metadata|raw_user_meta_data|app_metadata/.test(src(f))));
const register = read("app/(auth)/register/[[...rest]]/page.tsx");
const meta = register.slice(register.indexOf("data: {"), register.indexOf("}", register.indexOf("data: {")));
check("A05 signup sends only full_name and organization_name as metadata (no organization_id or role)",
  /full_name/.test(meta) && /organization_name/.test(meta) && !/organization_id|role/.test(meta));
check("A06 the scan route resolves the organization from the authenticated user id, never from the request",
  /getOrgContext: \(authUserId\) => getUserOrgContext\(authUserId\)/.test(read("app/api/scan/route.ts")));
const flow = read("lib/scan/scanFlow.ts");
const bodyParse = flow.slice(flow.indexOf("const { input, input_type } = body"), flow.indexOf("const admission"));
check("A07 the scan request body is never used for organization or user identity", !/organization|user_id|userId/.test(bodyParse.replace(/ctx\.userId/g, "")));
check("A08 cbc_admit_scan derives the organization from public.users for auth.uid() (no parameter)",
  /SELECT u\.organization_id INTO v_org FROM public\.users u WHERE u\.id = v_user;/.test(read("infra/supabase/migrations/001_scan_admission.sql")));

console.log(`\n=== Gate 007A tenant guard: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
