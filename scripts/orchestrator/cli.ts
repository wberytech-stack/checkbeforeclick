/**
 * Gate 005A - Orchestrator v1 CLI (local only, no AI calls, no writes to git).
 *
 * Usage (from repo root). Runs with Node's built-in TypeScript support
 * (Node >= 22.18; CI pins 24.14.0); no tsx or other runner is fetched.
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/orchestrator/cli.ts \
 *     [--handoff .agents/claude-handoff.yaml] [--review .agents/chatgpt-review.yaml] \
 *     [--out <dir>] [--remote-fixture <file.json>]
 *
 * --remote-fixture  JSON map { "<branch>": "<sha>" } used instead of origin
 *                   (offline smoke tests). Without it, the only network call
 *                   is the read-only `git ls-remote origin refs/heads/<branch>`.
 * --out             writes review-request.json / claude-work-request.json /
 *                   founder-action.json / result.json into <dir>.
 *
 * Exit codes: 0 = loop state reached normally; 1 = invalid or blocked;
 * 2 = usage or environment error.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { evaluate, type RemoteView } from "./orchestrator.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fatal(msg: string): never {
  console.error(`orchestrator: ${msg}`);
  process.exit(2);
}

// `yaml` is present only transitively (via inngest). Fail closed if absent;
// adding it as a direct devDependency is a founder decision (Gate 005A doc).
function loadYamlParser(): (src: string) => unknown {
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    return req("yaml").parse;
  } catch {
    fatal("the 'yaml' package is not resolvable from this repository; cannot parse protocol files");
  }
}

const parseYaml = loadYamlParser();

function readYaml(file: string): unknown | null {
  if (!existsSync(file)) return null;
  try {
    return parseYaml(readFileSync(file, "utf8"));
  } catch (e) {
    fatal(`could not parse ${file}: ${(e as Error).message}`);
  }
}

function originRemote(): RemoteView {
  return {
    branchHead(branch) {
      // Read-only. Branch was validated against BRANCH_RE (no leading "-").
      const out = execFileSync("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      }).trim();
      if (!out) return null;
      return out.split(/\s+/)[0] ?? null;
    },
  };
}

function fixtureRemote(file: string): RemoteView {
  const map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  return { branchHead: (branch) => map[branch] ?? null };
}

const handoffPath = arg("handoff") ?? ".agents/claude-handoff.yaml";
const reviewPath = arg("review") ?? ".agents/chatgpt-review.yaml";
const outDir = arg("out");
const remoteFixture = arg("remote-fixture");

const result = evaluate(
  readYaml(handoffPath),
  readYaml(reviewPath),
  remoteFixture ? fixtureRemote(remoteFixture) : originRemote()
);

if (outDir) {
  mkdirSync(outDir, { recursive: true });
  const write = (name: string, data: unknown) =>
    writeFileSync(path.join(outDir, name), JSON.stringify(data, null, 2) + "\n");
  write("result.json", result);
  if (result.reviewRequest) write("review-request.json", result.reviewRequest);
  if (result.workRequest) write("claude-work-request.json", result.workRequest);
  if (result.founderAction) write("founder-action.json", result.founderAction);
}

console.log(JSON.stringify({ state: result.state, reason: result.reason, transitions: result.transitions, errors: result.errors, notes: result.notes }, null, 2));
process.exit(["handoff_invalid", "review_invalid", "blocked_branch_not_on_origin", "blocked_head_mismatch"].includes(result.state) ? 1 : 0);
