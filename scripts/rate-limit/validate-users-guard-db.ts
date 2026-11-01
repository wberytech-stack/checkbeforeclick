// Gate 007A - disposable-database validation of infra/supabase/migrations/002_users_identity_guard.sql.
// LOCAL DISPOSABLE POSTGRES ONLY (AGENTS.md section 15): the Supabase Postgres image bound to 127.0.0.1.
//
// Setup (in order):
//   1. scripts/rate-limit/fixtures/users-guard-fixture.sql as supabase_admin (tables, handle_new_user on auth.users,
//      default grants, a deliberately permissive self-service policy, a user-callable definer function);
//   2. 002_users_identity_guard.sql as postgres (the role the Supabase SQL editor uses; not a superuser).
// Connections: CBC_007A_ADMIN_URL (postgres), CBC_007A_APP_URL (authenticator, then SET LOCAL ROLE as PostgREST
// does) and CBC_007A_AUTH_URL (supabase_auth_admin, the role Supabase Auth writes auth.users with).
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/validate-users-guard-db.ts
// Then remove the container and clear the three environment variables.
import { randomUUID } from "node:crypto";
import pg from "pg";

const urls = { admin: process.env.CBC_007A_ADMIN_URL ?? "", app: process.env.CBC_007A_APP_URL ?? "", auth: process.env.CBC_007A_AUTH_URL ?? "" };
for (const u of Object.values(urls)) {
  if (!/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\//.test(u)) {
    console.error("FAIL: all three URLs must point at a disposable database on 127.0.0.1");
    process.exit(2);
  }
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}

const admin = new pg.Client({ connectionString: urls.admin, ssl: false });
const app = new pg.Client({ connectionString: urls.app, ssl: false });
const auth = new pg.Client({ connectionString: urls.auth, ssl: false });

type Outcome = { rows: number; code: string | null; data: any[] };
async function attempt(client: pg.Client, setup: string[], sqlText: string, params: unknown[] = []): Promise<Outcome> {
  await client.query("BEGIN");
  try {
    for (const s of setup) await client.query(s);
    const r = await client.query(sqlText, params);
    await client.query("COMMIT");
    return { rows: r.rowCount ?? 0, code: null, data: r.rows };
  } catch (e) {
    await client.query("ROLLBACK");
    return { rows: 0, code: (e as { code?: string }).code ?? "unknown", data: [] };
  }
}
// The way PostgREST runs a request: SET LOCAL ROLE plus the JWT claims (transaction-local).
function asRole(role: "authenticated" | "anon" | "service_role", sub: string | null, sqlText: string, params: unknown[] = []) {
  const setup = [`SET LOCAL ROLE ${role}`];
  if (sub) setup.push(`SELECT set_config('request.jwt.claim.sub', '${sub}', true), set_config('request.jwt.claims', '${JSON.stringify({ sub, role })}', true)`);
  return attempt(app, setup, sqlText, params);
}
// The way Supabase Auth signs a user up: an INSERT into auth.users as supabase_auth_admin (fires handle_new_user).
async function signUp(meta: Record<string, string>): Promise<{ id: string; code: string | null }> {
  const id = randomUUID();
  const r = await attempt(auth, [], "INSERT INTO auth.users (id, aud, role, email, raw_user_meta_data) VALUES ($1, 'authenticated', 'authenticated', $2, $3)",
    [id, `${id}@example.test`, JSON.stringify(meta)]);
  return { id, code: r.code };
}
const row = async (id: string) => (await admin.query("SELECT organization_id, role, full_name FROM public.users WHERE id = $1", [id])).rows[0];

async function main() {
  await admin.connect();
  await app.connect();
  await auth.connect();

  const trig = await admin.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND NOT tgisinternal");
  check("U01 guard trigger cbc_guard_users_identity is installed on public.users", trig.rows.some((r) => r.tgname === "cbc_guard_users_identity"));
  const fn = await admin.query("SELECT prosecdef, proowner::regrole::text AS owner FROM pg_proc WHERE proname = 'cbc_guard_users_identity'");
  check("U02 guard function is not SECURITY DEFINER", fn.rowCount === 1 && fn.rows[0].prosecdef === false, JSON.stringify(fn.rows[0]));
  const ex = await admin.query("SELECT has_function_privilege('authenticated', 'public.cbc_guard_users_identity()', 'EXECUTE') AS a, has_function_privilege('anon', 'public.cbc_guard_users_identity()', 'EXECUTE') AS b");
  check("U03 guard function is not executable by authenticated or anon", ex.rows[0].a === false && ex.rows[0].b === false);

  // ---- compatibility: Supabase Auth sign-up through handle_new_user ------------------------------------------------
  const a = await signUp({ full_name: "Alice", organization_name: "Org A" });
  const ra = await row(a.id);
  check("U04 sign-up via auth.users (supabase_auth_admin) still provisions the users row through handle_new_user", a.code === null && !!ra?.organization_id && ra.role === "admin" && ra.full_name === "Alice", String(a.code));
  const b = await signUp({ full_name: "Bob", organization_name: "Org B" });
  const orgB = (await row(b.id)).organization_id as string;
  const orgA = ra.organization_id as string;

  // ---- the attack paths, with a permissive policy in place ------------------------------------------------------------
  let r = await asRole("authenticated", a.id, "UPDATE public.users SET organization_id = $1 WHERE id = $2", [orgB, a.id]);
  check("U05 signed-in user cannot move into another organization (42501)", r.code === "42501" && (await row(a.id)).organization_id === orgA, String(r.code));
  r = await asRole("authenticated", a.id, "UPDATE public.users SET role = 'owner' WHERE id = $1", [a.id]);
  check("U06 signed-in user cannot change their role (42501)", r.code === "42501" && (await row(a.id)).role === "admin", String(r.code));
  r = await asRole("authenticated", a.id, "UPDATE public.users SET id = $1 WHERE id = $2", [b.id, a.id]);
  check("U07 signed-in user cannot change their id (42501)", r.code === "42501", String(r.code));
  r = await asRole("authenticated", a.id, "UPDATE public.users SET full_name = 'Alice B' WHERE id = $1", [a.id]);
  check("U08 other columns stay editable where RLS allows it (full_name)", r.code === null && r.rows === 1 && (await row(a.id)).full_name === "Alice B", String(r.code));
  r = await asRole("authenticated", a.id, "UPDATE public.users SET organization_id = organization_id, role = role WHERE id = $1", [a.id]);
  check("U09 a no-op write of the same identity values is allowed", r.code === null, String(r.code));
  r = await asRole("authenticated", a.id, "DELETE FROM public.users WHERE id = $1", [a.id]);
  check("U10 signed-in user cannot delete their users row (42501)", r.code === "42501" && !!(await row(a.id)), String(r.code));
  const ghost = randomUUID();
  r = await asRole("authenticated", ghost, "INSERT INTO public.users (id, organization_id, role) VALUES ($1, $2, 'admin')", [ghost, orgB]);
  check("U11 signed-in user cannot insert a users row (42501 before any FK check)", r.code === "42501", String(r.code));
  r = await asRole("anon", null, "UPDATE public.users SET organization_id = $1", [orgB]);
  check("U12 anon cannot change organization_id (42501 or no visible rows)", r.code === "42501" || r.rows === 0, String(r.code));
  check("U13 after all attempts Alice is still in her own organization", (await row(a.id)).organization_id === orgA);

  // ---- compatibility: the privileged paths the application and operators use ------------------------------------------
  r = await asRole("service_role", null, "UPDATE public.users SET role = 'member' WHERE id = $1", [b.id]);
  check("U14 service_role (the app's data layer) can still change role", r.code === null && r.rows === 1 && (await row(b.id)).role === "member", String(r.code));
  await admin.query("UPDATE public.users SET role = 'admin' WHERE id = $1", [b.id]);
  check("U15 postgres (SQL editor / migrations) can still change identity columns", (await row(b.id)).role === "admin");
  const del = await attempt(auth, [], "DELETE FROM auth.users WHERE id = $1", [b.id]);
  check("U16 deleting the auth user (supabase_auth_admin) still cascades to public.users", del.code === null && (await row(b.id)) === undefined, String(del.code));

  // ---- documented limitation: a user-callable SECURITY DEFINER function bypasses the guard -----------------------------
  r = await asRole("authenticated", a.id, "SELECT public.cbc_fixture_definer_move_org($1)", [orgB]);
  const moved = (await row(a.id)).organization_id === orgB;
  check("U17 LIMITATION CONFIRMED: a definer function owned by postgres can still move the user (must be ruled out in production)", r.code === null && moved, String(r.code));
  await admin.query("UPDATE public.users SET organization_id = $1 WHERE id = $2", [orgA, a.id]);

  console.log(`\n=== Gate 007A users guard (disposable DB): ${passed} passed, ${failed} failed ===`);
}

main()
  .catch((e) => { failed++; console.log(`FAIL: harness error ${(e as Error).message}`); })
  .finally(async () => {
    for (const c of [app, auth, admin]) await c.end().catch(() => {});
    process.exit(failed === 0 ? 0 : 1);
  });
