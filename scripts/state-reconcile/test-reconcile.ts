/**
 * Gate 005E - state reconciliation tests. Builds one throwaway git repository
 * (real merges, a fast-forward, a double merge, a local-only commit) in the
 * OS temp dir, fills fixture YAML templates with its SHAs, and drives the
 * real CLI. No network, no remote, no writes outside the temp dir.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/state-reconcile/test-reconcile.ts
 *
 * Runs with Node's built-in TypeScript support (Node >= 22.18; CI pins 24.14.0).
 * No tsx or other runner is fetched: only the Node runtime and lockfile packages.
 *
 * The temp repo uses an isolated, empty git config (GIT_CONFIG_GLOBAL /
 * GIT_CONFIG_NOSYSTEM) so results do not depend on the developer's settings.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = process.cwd();
const DIR = path.join("scripts", "state-reconcile");
const FX = path.join(DIR, "fixtures");
const YAML = createRequire(path.join(ROOT, "package.json"))("yaml") as typeof import("yaml");

const work = mkdtempSync(path.join(tmpdir(), "cbc-reconcile-"));
const repo = path.join(work, "repo");
const emptyCfg = path.join(work, "gitconfig");
writeFileSync(emptyCfg, "");
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: emptyCfg,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
const commit = (file: string) => { writeFileSync(path.join(repo, file), file + "\n"); git("add", file); git("commit", "-q", "-m", file); return git("rev-parse", "HEAD"); };
const mergeNoFf = (b: string) => { git("merge", "-q", "--no-ff", "-m", `Merge ${b}`, b); return git("rev-parse", "HEAD"); };

// ---- build the repository graph ----
execFileSync("git", ["init", "-q", "-b", "master", repo], { env });
const S: Record<string, string> = {};
S.BASE = commit("base.txt");
git("switch", "-q", "-c", "feature-a"); S.A1 = commit("a1.txt"); git("switch", "-q", "master"); S.MA = mergeNoFf("feature-a");
git("switch", "-q", "-c", "feature-e"); S.E1 = commit("e1.txt"); git("switch", "-q", "master"); S.ME = mergeNoFf("feature-e");
git("switch", "-q", "-c", "feature-c"); S.C1 = commit("c1.txt"); git("switch", "-q", "master"); S.MC = mergeNoFf("feature-c");
git("switch", "-q", "-c", "feature-c-local", "feature-c"); S.C2 = commit("c2.txt"); git("switch", "-q", "master");
git("switch", "-q", "-c", "feature-b"); S.B1 = commit("b1.txt"); git("switch", "-q", "master");
git("switch", "-q", "-c", "feature-ff"); S.F1 = commit("f1.txt"); git("switch", "-q", "master"); git("merge", "-q", "--ff-only", "feature-ff");
git("switch", "-q", "-c", "feature-d"); S.D1 = commit("d1.txt"); git("switch", "-q", "master"); S.MD1 = mergeNoFf("feature-d");
S.MD2 = git("commit-tree", `${S.MD1}^{tree}`, "-p", S.MD1, "-p", S.D1, "-m", "second merge of feature-d");
git("update-ref", "refs/heads/master", S.MD2);
for (const k of Object.keys(S)) S[`${k}_7`] = S[k].slice(0, 7);

// ---- helpers ----
let passed = 0;
let failed = 0;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function load(fixture: string, canonical: boolean): string {
  let text = readFileSync(path.join(FX, fixture), "utf8").replace(/\r\n/g, "\n")
    .replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) => { if (!S[k]) throw new Error(`unknown token ${k}`); return S[k]; });
  if (canonical) text = YAML.parseDocument(text).toString({ lineWidth: 0, flowCollectionPadding: false });
  return text;
}

function run(stateFile: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [...process.execArgv, path.join(DIR, "cli.ts"), "--state", stateFile,
    "--repo", repo, "--ref-prefix", "refs/heads/", ...args], { cwd: ROOT, env, encoding: "utf8" });
  let report: { state?: string; changes?: string[]; errors?: string[] } = {};
  try { report = JSON.parse(r.stdout); } catch { /* reported below */ }
  return { code: r.status, report, stderr: r.stderr };
}

function test(name: string, body: () => string | null) {
  try {
    const problem = body();
    if (problem === null) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}: ${problem}`); failed++; }
  } catch (e) { console.error(`FAIL: ${name}: ${(e as Error).message}`); failed++; }
}

function stateFile(fixture: string, canonical = true): string {
  const f = path.join(work, `${fixture}.${passed + failed}.yaml`);
  writeFileSync(f, load(fixture, canonical));
  return f;
}

function expectReject(fixture: string, needle: string, canonical = true): string | null {
  const f = stateFile(fixture, canonical);
  const before = readFileSync(f, "utf8");
  for (const mode of ["--check", "--write"]) {
    const r = run(f, mode);
    if (r.code !== 2) return `${mode}: exit ${r.code} (state ${r.report.state})`;
    if (!(r.report.errors ?? []).some((e) => e.includes(needle))) return `${mode}: errors ${JSON.stringify(r.report.errors)}`;
  }
  return readFileSync(f, "utf8") === before ? null : "file was modified on rejection";
}

// ---- tests ----
test("R01 consistent state -> exit 0, no changes", () => {
  const r = run(stateFile("state-consistent.yaml"), "--check");
  return r.code === 0 && r.report.state === "consistent" ? null : `exit ${r.code} ${JSON.stringify(r.report)}`;
});

test("R02 merge detection: --no-ff merge found, entry moved, gate updated; repeat run is a no-op", () => {
  const f = stateFile("state-merge-pending.yaml");
  const c1 = run(f, "--check");
  if (c1.code !== 1 || c1.report.state !== "stale") return `check1 exit ${c1.code}`;
  if (!c1.report.changes!.some((c) => c.includes(`"feature-a": merged via ${S.MA_7} (head ${S.A1_7})`))) return `changes ${JSON.stringify(c1.report.changes)}`;
  if (c1.report.changes!.some((c) => c.includes("feature-b"))) return "feature-b wrongly detected as merged";
  const w1 = run(f, "--write");
  if (w1.code !== 0 || w1.report.state !== "written") return `write exit ${w1.code}`;
  const d = YAML.parse(readFileSync(f, "utf8"));
  const m = d.merged_branches_on_master[0];
  if (d.merged_branches_on_master.length !== 1 || m.branch !== "feature-a" || m.merge_commit !== S.MA || m.branch_head !== S.A1_7 ||
      m.parents.join(",") !== `${S.BASE_7},${S.A1_7}`) return `merged ${JSON.stringify(d.merged_branches_on_master)}`;
  if (d.unmerged_gate_branches.map((b: { branch: string }) => b.branch).join(",") !== "feature-b") return "unmerged list wrong";
  if (d.gates.GA.status !== "merged" || d.gates.GA.merge_commit !== S.MA_7) return `GA ${JSON.stringify(d.gates.GA)}`;
  if (d.gates.GB.status !== "in_progress_this_branch") return "GB changed";
  const bytes = readFileSync(f, "utf8");
  const c2 = run(f, "--check");
  if (c2.code !== 0) return `repeat check exit ${c2.code} ${JSON.stringify(c2.report.changes)}`;
  const w2 = run(f, "--write");
  if (w2.code !== 0 || w2.report.state !== "consistent") return `repeat write ${w2.report.state}`;
  return sha(readFileSync(f, "utf8")) === sha(bytes) ? null : "repeat write changed bytes";
});

test("R03 recorded local-only commit absent from repo, and recorded commit ahead of a merged tip -> both stay unmerged", () => {
  const r = run(stateFile("state-unmerged-recorded.yaml"), "--check");
  return r.code === 0 ? null : `exit ${r.code} ${JSON.stringify(r.report)}`;
});

test("R04 fast-forward merge (no merge commit) -> ambiguous, nothing written", () =>
  expectReject("state-fast-forward.yaml", "no merge commit"));

test("R05 two merge commits on master merge the same head -> ambiguous, nothing written", () =>
  expectReject("state-double-merge.yaml", "2 merge commits"));

test("R06 branch without recorded commit is missing -> ambiguous, nothing written", () =>
  expectReject("state-branch-missing.yaml", "cannot decide"));

test("R07 invalid YAML -> exit 2, nothing written", () =>
  expectReject("state-invalid-yaml.yaml", "YAML:", false));

test("R08 wrong schema_version -> exit 2, nothing written", () =>
  expectReject("state-old-schema.yaml", "schema_version must be 4"));

test("R09 unquoted SHA parsed as a number (3e24285 -> Infinity) -> exit 2, nothing written", () =>
  expectReject("state-numeric-sha.yaml", "not a quoted SHA string", false));

test("R10 merged record whose merge_commit does not merge branch_head -> exit 2", () =>
  expectReject("state-bad-merged-record.yaml", "merged \"feature-a\""));

test("R11 branch listed as both merged and unmerged -> exit 2", () =>
  expectReject("state-duplicate.yaml", "listed twice"));

test("R12 stored master SHA -> stale; write derives it; repeat is consistent", () => {
  const f = stateFile("state-stored-master.yaml");
  const c = run(f, "--check");
  if (c.code !== 1 || !c.report.changes!.some((x) => x.includes("remove stored master SHA"))) return `check ${c.code} ${JSON.stringify(c.report.changes)}`;
  if (run(f, "--write").code !== 0) return "write failed";
  const base = YAML.parse(readFileSync(f, "utf8")).repository.integration_base;
  if ("commit" in base || "matches_origin_master" in base || !String(base.commit_source).startsWith("derived")) return JSON.stringify(base);
  return run(f, "--check").code === 0 ? null : "repeat check not consistent";
});

test("R13 gate evidence naming two merged branches -> ambiguous, nothing written", () =>
  expectReject("state-gate-two-branches.yaml", "several merged branches"));

test("R14 non-canonical formatting only -> stale; write canonicalizes; repeat is a no-op", () => {
  const f = stateFile("state-consistent.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/\[\{/g, "[ { ").replace(/\}\]/g, " } ]"));   // padded flow style
  const c = run(f, "--check");
  if (c.code !== 1 || c.report.changes!.join() !== "canonical formatting") return `check ${c.code} ${JSON.stringify(c.report.changes)}`;
  run(f, "--write");
  const b = readFileSync(f, "utf8");
  run(f, "--write");
  return run(f, "--check").code === 0 && readFileSync(f, "utf8") === b ? null : "not idempotent";
});

test("R16 verified_at defaults to the merge commit date, so output is deterministic", () => {
  const f1 = stateFile("state-merge-pending.yaml");
  const f2 = stateFile("state-merge-pending.yaml");
  if (run(f1, "--write").code !== 0 || run(f2, "--write").code !== 0) return "write failed";
  const d = YAML.parse(readFileSync(f1, "utf8"));
  const want = git("show", "-s", "--format=%cs", S.MA);
  if (d.merged_branches_on_master[0].verified_at !== want || d.gates.GA.verified_at !== want) return `dates ${d.merged_branches_on_master[0].verified_at} ${d.gates.GA.verified_at} != ${want}`;
  return readFileSync(f1, "utf8") === readFileSync(f2, "utf8") ? null : "two runs differ";
});

test("R15 CRLF line endings preserved on write", () => {
  const f = stateFile("state-merge-pending.yaml");
  writeFileSync(f, readFileSync(f, "utf8").replace(/\n/g, "\r\n"));
  if (run(f, "--write").code !== 0) return "write failed";
  const t = readFileSync(f, "utf8");
  return t.includes("\r\n") && !/[^\r]\n/.test(t) ? null : "line endings changed";
});

rmSync(work, { recursive: true, force: true });
console.log(`\n=== Gate 005E state reconcile: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
