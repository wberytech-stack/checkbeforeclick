/**
 * Gate 005G - Claude Code loop runner (local, read-only git; no credentials; no API calls).
 *
 * After Claude pushes gate head H with `.agents/review-ready/<gate>.yaml` set to
 * ready_for_review, the runner waits for the automated review of exactly H on
 * `automation/reviews`, copies it into the untracked outbox, and runs the
 * unchanged Gate 005A orchestrator to decide the next step.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/review-loop/runner.ts \
 *     --branch <gate-branch> --head <sha40> [--timeout-min 20] [--interval-s 60] [--out .agents/outbox]
 *
 * Exit codes: 0 = changes_requested (claude-work-request.json written; Claude may
 * act under AGENTS.md section 6.4); 3 = founder_action_required (approval
 * recommendation, escalation, adapter rejection, round/budget stop); 4 = timeout
 * (no review delivered); 2 = usage, environment or invalid-delivery error.
 *
 * Runs with Node's built-in TypeScript support (Node >= 22.18; CI pins 24.14.0).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { evaluate, type RemoteView } from "../orchestrator/orchestrator.ts";
import { GATE_BRANCH_RE, Git, REVIEW_BRANCH, gateIdFromBranch, isObj, loadYaml } from "../reviewer/lib.ts";

export interface RunnerOptions {
  git: Git;
  branch: string;
  head: string;
  outDir: string;
  timeoutMs: number;
  intervalMs: number;
  sleep?: (ms: number) => Promise<void>;
}
export interface RunnerResult { exitCode: 0 | 2 | 3 | 4; state: string; reason: string; dir?: string }

export async function runLoopStep(o: RunnerOptions): Promise<RunnerResult> {
  const gate = gateIdFromBranch(o.branch);
  if (!gate || !/^[0-9a-f]{40}$/.test(o.head)) return { exitCode: 2, state: "usage_error", reason: "invalid branch or head" };
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const base = `reviews/${gate}/${o.head}`;
  const rb = `refs/remotes/origin/${REVIEW_BRANCH}`;
  const deadline = Date.now() + o.timeoutMs;
  let resultSrc: string | null = null;
  while (true) {
    if (o.git.fetchBranch(REVIEW_BRANCH)) resultSrc = o.git.showFile(rb, `${base}/adapter-result.json`);
    if (resultSrc !== null || Date.now() >= deadline) break;
    await sleep(o.intervalMs);
  }
  if (resultSrc === null) return { exitCode: 4, state: "timeout", reason: `no delivery at ${REVIEW_BRANCH}:${base} before timeout` };

  const dir = path.join(o.outDir, "reviews", o.head);
  mkdirSync(dir, { recursive: true });
  let result: { state?: string; rejection?: { code?: string; detail?: string }; provenance?: { gate?: string; head_commit?: string } };
  try { result = JSON.parse(resultSrc); } catch { return { exitCode: 2, state: "invalid_delivery", reason: "adapter-result.json is not JSON" }; }
  if (result.provenance?.gate !== gate || result.provenance?.head_commit !== o.head)
    return { exitCode: 2, state: "invalid_delivery", reason: "delivered result is for a different gate or head" };
  writeFileSync(path.join(dir, "adapter-result.json"), resultSrc);

  if (result.state !== "review_written") {
    const fa = { kind: "cbc.founder_action_required", schema_version: 1, project: "cbc", gate, branch: o.branch, head_commit: o.head,
      reason: `adapter_rejected:${result.rejection?.code ?? "unknown"}`, items: [result.rejection?.detail ?? ""] };
    writeFileSync(path.join(dir, "founder-action.json"), JSON.stringify(fa, null, 2) + "\n");
    return { exitCode: 3, state: "founder_action_required", reason: fa.reason, dir };
  }

  const reviewSrc = o.git.showFile(rb, `${base}/chatgpt-review.yaml`);
  const requestSrc = o.git.showFile(rb, `${base}/review-request.json`);
  if (reviewSrc === null || requestSrc === null) return { exitCode: 2, state: "invalid_delivery", reason: "review_written without review or request file" };
  writeFileSync(path.join(dir, "chatgpt-review.yaml"), reviewSrc);
  writeFileSync(path.join(dir, "review-request.json"), requestSrc);

  const YAML = loadYaml();
  let request: Record<string, unknown>;
  let review: unknown;
  try { request = JSON.parse(requestSrc); review = YAML.parse(reviewSrc); } catch { return { exitCode: 2, state: "invalid_delivery", reason: "delivered files do not parse" }; }
  if (!isObj(request) || request.head_commit !== o.head || request.branch !== o.branch) return { exitCode: 2, state: "invalid_delivery", reason: "request does not match branch/head" };

  // A Gate 005A v4-compatible handoff view of the delivered request (head taken from git, not self-referenced).
  const handoff = {
    schema_version: 4, project: "cbc", status: "ready_for_review", gate, branch: o.branch,
    base_commit: request.base_commit, head_commit: o.head, summary: request.summary,
    changed_files: request.changed_files, validation: request.validation,
    delegated_actions: { draft_pr: { is_draft: true } }, founder_only_actions_requested: request.founder_only_actions_requested,
  };
  const remote: RemoteView = { branchHead: (b) => o.git.remoteHead(b) };
  const r = evaluate(handoff, review, remote);
  writeFileSync(path.join(dir, "result.json"), JSON.stringify(r, null, 2) + "\n");
  if (r.workRequest) writeFileSync(path.join(dir, "claude-work-request.json"), JSON.stringify(r.workRequest, null, 2) + "\n");
  if (r.founderAction) writeFileSync(path.join(dir, "founder-action.json"), JSON.stringify(r.founderAction, null, 2) + "\n");
  if (r.state === "changes_requested") return { exitCode: 0, state: r.state, reason: r.reason, dir };
  if (r.state === "founder_action_required") return { exitCode: 3, state: r.state, reason: r.reason, dir };
  return { exitCode: 2, state: r.state, reason: `${r.reason}${r.errors.length ? ": " + r.errors.join("; ") : ""}`, dir };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const arg = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
  const branch = arg("branch") ?? "", head = arg("head") ?? "";
  if (!GATE_BRANCH_RE.test(branch)) { console.error("runner: --branch must be a gate branch"); process.exit(2); }
  runLoopStep({
    git: new Git(process.cwd()), branch, head, outDir: arg("out") ?? ".agents/outbox",
    timeoutMs: Number(arg("timeout-min") ?? 20) * 60_000, intervalMs: Number(arg("interval-s") ?? 60) * 1000,
  }).then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.exitCode); },
    (e) => { console.error(`runner: ${(e as Error).message.split("\n")[0]}`); process.exit(2); });
}
