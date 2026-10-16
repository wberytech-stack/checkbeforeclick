/**
 * Gate 005E - state.yaml reconciliation CLI (read-only git; writes only the
 * state file in --write mode; never commits, pushes, or calls any API).
 *
 *   npx --yes tsx@4.23.0 scripts/state-reconcile/cli.ts --check
 *   npx --yes tsx@4.23.0 scripts/state-reconcile/cli.ts --write
 *
 * Options:
 *   --state <file>        default .agents/state.yaml
 *   --ref-prefix <p>      where master/branches are read from; default refs/remotes/origin/
 *   --repo <dir>          git working directory; default current directory
 *   --report <file>       write a JSON report (state, changes, errors)
 *   --date YYYY-MM-DD     tests only: override verified_at (default: the merge
 *                         commit's committer date, so output is deterministic)
 *
 * Exit codes: 0 = consistent (or written); 1 = --check found stale state;
 *             2 = invalid, ambiguous, or environment error (nothing written).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { apply, plan, render, type GitView } from "./reconcile";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const statePath = arg("state") ?? ".agents/state.yaml";
const refPrefix = arg("ref-prefix") ?? "refs/remotes/origin/";
const repo = arg("repo") ?? process.cwd();
const reportPath = arg("report");
const dateOverride = arg("date");
const mode = flag("write") ? "write" : flag("check") ? "check" : null;

function finish(code: number, state: string, changes: string[], errors: string[]): never {
  const report = { kind: "cbc.state_reconcile_report", schema_version: 1, mode, state, state_file: statePath, changes, errors };
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
  process.exit(code);
}

if (!mode) finish(2, "usage_error", [], ["pass --check or --write"]);
if (dateOverride !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(dateOverride)) finish(2, "usage_error", [], ["--date must be YYYY-MM-DD"]);
if (!/^[A-Za-z0-9/_.-]*$/.test(refPrefix) || refPrefix.startsWith("-")) finish(2, "usage_error", [], ["invalid --ref-prefix"]);

// `yaml` is a transitive dependency (see Gate 005A/005E docs). Fail closed if absent.
let YAML: typeof import("yaml");
try {
  YAML = createRequire(path.join(process.cwd(), "package.json"))("yaml");
} catch {
  finish(2, "environment_error", [], ["the 'yaml' package is not resolvable from this repository"]);
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }).trim();
}
function gitOk(args: string[]): boolean {
  try { execFileSync("git", args, { cwd: repo, stdio: "ignore", timeout: 60000 }); return true; } catch { return false; }
}

let chainCache: Array<{ sha: string; parents: string[] }> | null = null;
const gitView: GitView = {
  masterHead: () => git(["rev-parse", "--verify", `${refPrefix}master^{commit}`]),
  branchHead(branch) {
    try { return git(["rev-parse", "--verify", "--quiet", `${refPrefix}${branch}^{commit}`]) || null; } catch { return null; }
  },
  resolve(sha) {
    if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
    try { return git(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) || null; } catch { return null; }
  },
  isAncestor: (a, b) => gitOk(["merge-base", "--is-ancestor", a, b]),
  firstParentChain() {
    if (!chainCache) {
      chainCache = git(["rev-list", "--first-parent", "--parents", `${refPrefix}master`])
        .split("\n").filter(Boolean).map((l) => { const [sha, ...parents] = l.split(" "); return { sha, parents }; });
    }
    return chainCache;
  },
  commitDate: (sha) => git(["show", "-s", "--format=%cs", sha]),
};

if (!existsSync(statePath)) finish(2, "invalid", [], [`${statePath} not found`]);
const raw = readFileSync(statePath, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const src = raw.replace(/\r\n/g, "\n");
const doc = YAML.parseDocument(src);
if (doc.errors.length > 0) finish(2, "invalid", [], doc.errors.map((e) => `YAML: ${e.message.split("\n")[0]}`));

let p;
try {
  p = plan(doc, gitView);
} catch (e) {
  finish(2, "environment_error", [], [`git: ${(e as Error).message.split("\n")[0]}`]);
}
if (p.errors.length > 0) finish(2, "ambiguous_or_invalid", p.changes, p.errors);

apply(doc, gitView, p, dateOverride);
const out = render(doc);
const changes = [...p.changes];
if (out !== src && changes.length === 0) changes.push("canonical formatting");

if (mode === "check") finish(changes.length > 0 ? 1 : 0, changes.length > 0 ? "stale" : "consistent", changes, []);
if (changes.length === 0) finish(0, "consistent", [], []);

// Re-validate the output before replacing the file (atomic temp + rename).
const check = YAML.parseDocument(out);
if (check.errors.length > 0) finish(2, "internal_error", changes, ["rendered state.yaml does not parse"]);
const tmp = `${statePath}.tmp-${process.pid}`;
writeFileSync(tmp, eol === "\n" ? out : out.replace(/\n/g, "\r\n"));
renameSync(tmp, statePath);
finish(0, "written", changes, []);
