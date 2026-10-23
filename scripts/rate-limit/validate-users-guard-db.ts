// Gate 007A - disposable-database validation of infra/supabase/migrations/002_users_identity_guard.sql.
// LOCAL DISPOSABLE POSTGRES ONLY (AGENTS.md section 15): a Supabase Postgres image bound to 127.0.0.1, the same
// container setup as validate-admission-db.ts. NOT YET RUN: running it needs founder approval for disposable
// database work.
//
// The worst case is simulated on purpose: a permissive RLS policy that lets a signed-in user update their own row
// with no column restriction. The guard must still block identity changes.
//
// Run (PowerShell), after starting the container and applying 002 as "postgres":
//   $env:CBC_007A_ADMIN_URL = "postgresql://postgres:<local-test-password>@127.0.0.1:55471/postgres"
//   $env:CBC_007A_APP_URL   = "postgresql://authenticator:<local-test-password>@127.0.0.1:55471/postgres"
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit/validate-users-guard-db.ts
//   Remove-Item Env:CBC_007A_ADMIN_URL, Env:CBC_007A_APP_URL
import { randomUUID } from "node:crypto";
import pg from "pg";

const adminUrl = process.env.CBC_007A_ADMIN_URL ?? "";
const appUrl = process.env.CBC_007A_APP_URL ?? "";
for (const u of [adminUrl, appUrl]) {
  if (!/^postgresql:\/\/[^@]+@127\.0\.0\.1:\d+\//.test(u)) {
    console.error("FAIL: both URLs must point at a disposable database on 127.0.0.1");
    process.exit(2);
  }
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, info = ""): void {
  if (ok) { passed++; console.log(`PASS: ${label}`); }
  else { failed++; console.log(`FAIL: ${label}${info ? `  [${info}]` : ""}`); }
}

const admin = new pg.Client({ connectionString: adminUrl, ssl: false });
const app = new pg.Client({ connectionString: appUrl, ssl: false });

// Runs one statement the way PostgREST does: SET LOCAL ROLE plus the JWT claims. Returns the SQLSTATE on error.
async function asRole(role: "authenticated" | "anon", sub: string | null, sqlText: string, params: unknown[] = []): Promise<{ rows: number; code: string | null }> {
  await app.query("BEGIN");
  try {
    await app.query(`SET LOCAL ROLE ${role}`);
    if (sub) await app.query("SELECT set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', $2, true)", [sub, JSON.stringify({ sub, role })]);
    const r = await app.query(sqlText, params);
    await app.query("COMMIT");
    return { rows: r.rowCount ?? 0, code: null };
  } catch (e) {
    await app.query("ROLLBACK");
    return { rows: 0, code: (e as { code?: string }).code ?? "unknown" };
  }
}
const row = async (id: string) => (await admin.query("SELECT organization_id, role, full_name FROM public.users WHERE id = $1", [id])).rows[0];

async function main() {
  await admin.connect();
  await app.connect();

  // Fixture: the columns the app reads, plus a deliberately permissive self-service policy (worst case).
  await admin.query("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS role text");
  await admin.query("ALTER TABLE public.users ADD COLUMN IF NOT EXISTS full_name text");
  await admin.query("ALTER TABLE public.users ENABLE ROW LEVEL SECURITY");
  await admin.query("GRANT SELECT, INSERT, UPDATE, DELETE ON public.users TO authenticated, anon");
  await admin.query("DROP POLICY IF EXISTS cbc_test_permissive ON public.users");
  await admin.query("CREATE POLICY cbc_test_permissive ON public.users FOR ALL TO authenticated USING (id = auth.uid()) WITH CHECK (true)");

  const orgA = randomUUID();
  const orgB = randomUUID();
  const user = randomUUID();
  await admin.query("INSERT INTO public.users (id, organization_id, role, full_name) VALUES ($1, $2, 'member', 'Test User')", [user, orgA]);

  const trig = await admin.query("SELECT 1 FROM pg_trigger WHERE tgname = 'cbc_guard_users_identity' AND NOT tgisinternal");
  check("U01 guard trigger is installed on public.users", trig.rowCount === 1);

  let r = await asRole("authenticated", user, "UPDATE public.users SET organization_id = $1 WHERE id = $2", [orgB, user]);
  check("U02 signed-in user cannot move to another organization (42501), even with a permissive policy", r.code === "42501" && (await row(user)).organization_id === orgA, String(r.code));

  r = await asRole("authenticated", user, "UPDATE public.users SET role = 'admin' WHERE id = $1", [user]);
  check("U03 signed-in user cannot change their role (42501)", r.code === "42501" && (await row(user)).role === "member", String(r.code));

  r = await asRole("authenticated", user, "UPDATE public.users SET id = $1 WHERE id = $2", [randomUUID(), user]);
  check("U04 signed-in user cannot change their id (42501)", r.code === "42501", String(r.code));

  r = await asRole("authenticated", user, "UPDATE public.users SET full_name = 'Renamed' WHERE id = $1", [user]);
  check("U05 other columns stay editable where RLS allows it (full_name)", r.code === null && r.rows === 1 && (await row(user)).full_name === "Renamed", String(r.code));

  r = await asRole("authenticated", user, "UPDATE public.users SET organization_id = organization_id, role = role WHERE id = $1", [user]);
  check("U06 a no-op write of the same identity values is allowed", r.code === null, String(r.code));

  const other = randomUUID();
  r = await asRole("authenticated", other, "INSERT INTO public.users (id, organization_id, role) VALUES ($1, $2, 'admin')", [other, orgB]);
  check("U07 signed-in user cannot insert a users row (42501)", r.code === "42501", String(r.code));

  r = await asRole("authenticated", user, "DELETE FROM public.users WHERE id = $1", [user]);
  check("U08 signed-in user cannot delete their users row (42501)", r.code === "42501" && (await row(user)) !== undefined, String(r.code));

  r = await asRole("anon", null, "UPDATE public.users SET organization_id = $1", [orgB]);
  check("U09 anon is blocked as well (42501 or no visible rows)", r.code === "42501" || r.rows === 0, String(r.code));

  await admin.query("UPDATE public.users SET organization_id = $1, role = 'admin' WHERE id = $2", [orgB, user]);
  const moved = await row(user);
  check("U10 postgres (dashboard / migrations) can still change organization and role", moved.organization_id === orgB && moved.role === "admin");

  await admin.query("DELETE FROM public.users WHERE id = $1", [user]);
  await admin.query("DROP POLICY IF EXISTS cbc_test_permissive ON public.users");

  console.log(`\n=== Gate 007A users guard (disposable DB): ${passed} passed, ${failed} failed ===`);
}

main()
  .catch((e) => { failed++; console.log(`FAIL: harness error ${(e as Error).message}`); })
  .finally(async () => {
    await app.end().catch(() => {});
    await admin.end().catch(() => {});
    process.exit(failed === 0 ? 0 : 1);
  });
