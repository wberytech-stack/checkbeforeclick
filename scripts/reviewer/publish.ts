/**
 * Gate 005G - delivery of adapter output to the append-only `automation/reviews` branch.
 *
 * Builds commits with git plumbing (temporary index; no checkout, no working-tree
 * changes) and pushes WITHOUT force. A rejected (non-fast-forward) push is retried
 * from the new tip. Layout (Gate 005F section 2.1):
 *   reviews/<gate>/<head>/{review-request.json, adapter-result.json, chatgpt-review.yaml}
 *   ledger/<YYYY-MM>.jsonl   (one line per model call)
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Git, REVIEW_BRANCH, SHA40_RE, isObj } from "./lib.ts";

const BOT = {
  GIT_AUTHOR_NAME: "cbc-automation", GIT_AUTHOR_EMAIL: "cbc-automation@users.noreply.github.com",
  GIT_COMMITTER_NAME: "cbc-automation", GIT_COMMITTER_EMAIL: "cbc-automation@users.noreply.github.com",
};

function withIndex(git: Git, fn: (ig: Git) => string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "cbc-idx-"));
  try {
    return fn(new Git(git.repo, { ...git.env, ...BOT, ...pickIdentity(git.env), GIT_INDEX_FILE: path.join(dir, "index") }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const pickIdentity = (env: NodeJS.ProcessEnv) =>
  Object.fromEntries(Object.entries(env).filter(([k, v]) => /^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL)$/.test(k) && v));

function addFile(ig: Git, p: string, content: string) {
  const blob = ig.run(["hash-object", "-w", "--stdin"], content);
  ig.run(["update-index", "--add", "--cacheinfo", `100644,${blob},${p}`]);
}

export function initReviewBranch(git: Git): string {
  if (git.remoteHead(REVIEW_BRANCH) !== null) throw new Error(`${REVIEW_BRANCH} already exists on origin`);
  const commit = withIndex(git, (ig) => {
    addFile(ig, "README.md",
      "# automation/reviews\n\nAppend-only delivery branch for CBC automated reviews (Gate 005F/005G).\n" +
      "Never merged into master. Written only by the approved review workflow. Never force-pushed.\n");
    addFile(ig, "ledger/.gitkeep", "");
    const tree = ig.run(["write-tree"]);
    return ig.run(["commit-tree", tree, "-m", "init automation/reviews (founder-run)"]);
  });
  git.run(["push", "origin", `${commit}:refs/heads/${REVIEW_BRANCH}`]);
  return commit;
}

export function publish(o: { git: Git; outDir: string; gate: string; head: string; runId: string; attempts?: number }): { commit: string; path: string; ledger: boolean; alreadyPublished: boolean } {
  const { git } = o;
  if (!/^\d{3}[A-Z]$/.test(o.gate) || !SHA40_RE.test(o.head)) throw new Error("invalid gate or head");
  const read = (n: string) => { const f = path.join(o.outDir, n); return existsSync(f) ? readFileSync(f, "utf8") : null; };
  const resultSrc = read("adapter-result.json");
  if (resultSrc === null) throw new Error("adapter-result.json missing");
  const result = JSON.parse(resultSrc) as { state?: string; provenance?: Record<string, unknown> & { call?: Record<string, unknown> } };
  const pv = result.provenance ?? {};
  if (pv.head_commit !== o.head || pv.gate !== o.gate) throw new Error("adapter-result does not match gate/head");
  const review = read("chatgpt-review.yaml");
  if (result.state === "review_written" && review === null) throw new Error("review_written but chatgpt-review.yaml missing");
  if (result.state !== "review_written" && review !== null) throw new Error("rejected result must not carry a review");
  const request = read("review-request.json");
  const dir = `reviews/${o.gate}/${o.head}`;
  const call = isObj(pv.call) ? pv.call : {};

  for (let attempt = 1; attempt <= (o.attempts ?? 3); attempt++) {
    if (!git.fetchBranch(REVIEW_BRANCH)) throw new Error(`${REVIEW_BRANCH} cannot be fetched`);
    const tip = git.run(["rev-parse", "--verify", `refs/remotes/origin/${REVIEW_BRANCH}^{commit}`]);
    const existing = git.showFile(tip, `${dir}/adapter-result.json`);
    if (existing !== null) {
      if (existing === resultSrc) return { commit: tip, path: dir, ledger: false, alreadyPublished: true };
      let made = false;
      try { made = (JSON.parse(existing) as { provenance?: { call?: { made?: boolean } } }).provenance?.call?.made === true; } catch { throw new Error(`${dir}/adapter-result.json on ${REVIEW_BRANCH} is malformed`); }
      if (made) throw new Error(`${dir} already holds a result with a model call; refusing to replace it`);
    }
    const commit = withIndex(git, (ig) => {
      ig.run(["read-tree", tip]);
      // A previous pre-call rejection for this head is superseded; history keeps it.
      ig.run(["rm", "--cached", "-r", "-q", "--ignore-unmatch", dir]);
      addFile(ig, `${dir}/adapter-result.json`, resultSrc);
      if (request !== null) addFile(ig, `${dir}/review-request.json`, request);
      if (review !== null) addFile(ig, `${dir}/chatgpt-review.yaml`, review);
      if (call.made === true) {
        const started = typeof pv.started_at === "string" ? pv.started_at : new Date().toISOString();
        const ledgerPath = `ledger/${started.slice(0, 7)}.jsonl`;
        const prev = ig.showFile(tip, ledgerPath) ?? "";
        const line = JSON.stringify({ run_id: o.runId, at: started, gate: o.gate, head: o.head, model: call.model, input_tokens: call.input_tokens ?? null, output_tokens: call.output_tokens ?? null, usage_reported: call.usage_reported === true, cost_usd: call.cost_usd });
        addFile(ig, ledgerPath, (prev === "" || prev.endsWith("\n") ? prev : prev + "\n") + line + "\n");
      }
      const tree = ig.run(["write-tree"]);
      return ig.run(["commit-tree", tree, "-p", tip, "-m", `review ${o.gate} ${o.head.slice(0, 7)}: ${result.state} (run ${o.runId})`]);
    });
    if (git.ok(["push", "origin", `${commit}:refs/heads/${REVIEW_BRANCH}`])) return { commit, path: dir, ledger: call.made === true, alreadyPublished: false };
  }
  throw new Error(`push to ${REVIEW_BRANCH} kept failing (non-fast-forward or remote error); not forced`);
}
