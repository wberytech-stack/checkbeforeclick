/**
 * Gate 005G - offline tests for the reviewer adapter, publisher, loop runner,
 * target selection and workflow safety properties.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/reviewer/test-reviewer.ts
 *
 * Every test builds throwaway git repositories in the OS temp dir (a bare
 * "origin", a developer clone, a CI clone) with an isolated empty git config.
 * The reviewer is a fixture client: NO network, NO credentials, NO API calls.
 * Fake secrets are assembled at runtime so this file never matches the scanner.
 *
 * Runs with Node's built-in TypeScript support (Node >= 22.18; CI pins 24.14.0).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { validateReview } from "../orchestrator/orchestrator.ts";
import { runLoopStep } from "../review-loop/runner.ts";
import { FOUNDER_DECISION_TEMPLATE, runAdapter, type ReviewerClient, type ReviewerInput, type ReviewerResponse } from "./adapter.ts";
import { AUTHORIZATION_MARKER, Git, REVIEW_BRANCH, loadYaml, selectTargets } from "./lib.ts";
import { initReviewBranch, publish } from "./publish.ts";

const YAML = loadYaml();
const ROOT = process.cwd();
const BRANCH = "gate-005z-fixture";
const GATE = "005Z";
const MODEL = "test-model-2026-01-01";
const ENV_OK = { CBC_REVIEWER_ENABLED: "enabled", CBC_REVIEWER_MODEL: MODEL, CBC_REVIEW_MONTHLY_ALLOWANCE_USD: "20", CBC_VERCEL_POLICY_VERIFIED: "verified-2026-10-16" };
const FAKE_AWS = "AKIA" + "Q".repeat(16);

const roots: string[] = [];

interface WorldOpts {
  authorized?: boolean;
  modelId?: string;
  readyStatus?: string;
  readyExtra?: string;
  noReady?: boolean;
  files?: Record<string, string>;
  initReviewBranch?: boolean;
}
interface World { root: string; env: NodeJS.ProcessEnv; dev: Git; ci: Git; head: string; master: string; out: string; commitOnBranch: (file: string, content: string) => string; commitOnMaster: (file: string, content: string) => string }

function makeWorld(o: WorldOpts = {}): World {
  const root = mkdtempSync(path.join(tmpdir(), "cbc-005g-"));
  roots.push(root);
  const cfg = path.join(root, "gitconfig");
  writeFileSync(cfg, "");
  const env: NodeJS.ProcessEnv = {
    ...process.env, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const origin = path.join(root, "origin.git");
  sh(root, "init", "-q", "--bare", "-b", "master", origin);
  const devDir = path.join(root, "dev");
  sh(root, "clone", "-q", origin, devDir);
  sh(devDir, "checkout", "-q", "-B", "master");
  const put = (rel: string, content: string) => { const f = path.join(devDir, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, content); sh(devDir, "add", "--", rel); };
  put("AGENTS.md", `# CBC Project Constitution (fixture)\n\n${o.authorized === false ? "" : AUTHORIZATION_MARKER + "\n\nfixture section.\n"}`);
  put(".agents/chatgpt.md", "# Reviewer policy (fixture)\nReview the evidence.\n");
  const model = o.modelId ?? MODEL;
  put(".agents/automation.yaml", [
    "schema_version: 1", "project: cbc", "reviewer:", `  model_id: "${model}"`, "  max_input_tokens: 60000", "  max_output_tokens: 8000", "  max_rounds_per_gate: 3",
    "budget:", "  monthly_allowance_usd: 20", "  prices_usd_per_million_tokens:", `    "${MODEL}": { input: 2, output: 8 }`, "transport:", "  review_branch: automation/reviews", "",
  ].join("\n"));
  put("docs/readme.md", "base\n");
  sh(devDir, "commit", "-q", "-m", "base");
  sh(devDir, "push", "-q", "origin", "master");
  sh(devDir, "checkout", "-q", "-b", BRANCH);
  for (const [k, v] of Object.entries(o.files ?? { "docs/change.md": "a harmless change\n" })) put(k, v);
  if (!o.noReady) put(`.agents/review-ready/${GATE}.yaml`, [
    "schema_version: 1", "project: cbc", `gate: "${GATE}"`, `branch: ${BRANCH}`, `status: ${o.readyStatus ?? "ready_for_review"}`,
    "summary: fixture change", "validation:", "  build: passed", "  results: [\"PASS: fixture\"]", "founder_only_actions_requested: []", o.readyExtra ?? "", "",
  ].join("\n"));
  sh(devDir, "commit", "-q", "-m", "gate change");
  sh(devDir, "push", "-q", "origin", BRANCH);
  const dev = new Git(devDir, env);
  if (o.initReviewBranch !== false) initReviewBranch(dev);
  const ciDir = path.join(root, "ci");
  sh(root, "clone", "-q", origin, ciDir);
  const commitOn = (branch: string) => (file: string, content: string) => {
    sh(devDir, "checkout", "-q", branch); put(file, content); sh(devDir, "commit", "-q", "-m", `edit ${file}`); sh(devDir, "push", "-q", "origin", branch);
    return sh(devDir, "rev-parse", "HEAD");
  };
  return {
    root, env, dev, ci: new Git(ciDir, env), head: sh(devDir, "rev-parse", BRANCH), master: sh(devDir, "rev-parse", "master"),
    out: path.join(root, "out"), commitOnBranch: commitOn(BRANCH), commitOnMaster: commitOn("master"),
  };
}

function output(w: { head: string }, patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    review_target: { gate: GATE, branch: BRANCH, reviewed_commit: w.head },
    recommendation: "recommend_changes",
    findings: [{ severity: "low", file: "docs/change.md", summary: "typo" }],
    required_changes: [{ id: "R1", file: "docs/change.md", change: "Fix the typo in the first line.", in_scope: true, founder_only: false }],
    hard_rule_check: { production_or_azure_access: "none", migrations_applied_to_real_db: "none", secrets_exposed: "none", dependency_changes: "none",
      tenant_context_invariant: "n/a", delegated_actions_within_scope: "yes", founder_only_actions_taken: "none" },
    open_questions_for_founder: [],
    ...patch,
  };
}

function client(reply: (input: ReviewerInput) => ReviewerResponse | Promise<ReviewerResponse>): ReviewerClient & { calls: number } {
  const c = { calls: 0, async review(input: ReviewerInput) { c.calls++; return reply(input); } };
  return c;
}
const ok = (w: { head: string }, patch?: Record<string, unknown>) => client(() => ({ raw: JSON.stringify(output(w, patch)), complete: true, usage: { input_tokens: 1000, output_tokens: 500 }, response_id: "resp_fixture" }));

async function run(w: World, c: ReviewerClient, env: Record<string, string | undefined> = ENV_OK, head = w.head) {
  rmSync(w.out, { recursive: true, force: true });
  return runAdapter({ git: w.ci, branch: BRANCH, head, outDir: w.out, client: c, env, runId: "test" });
}
const readOut = (w: World, f: string) => readFileSync(path.join(w.out, f), "utf8");

let passed = 0;
let failed = 0;
async function test(name: string, body: () => Promise<string | null> | string | null) {
  try {
    const p = await body();
    if (p === null) { console.log(`PASS: ${name}`); passed++; } else { console.error(`FAIL: ${name}: ${p}`); failed++; }
  } catch (e) { console.error(`FAIL: ${name}: ${(e as Error).stack?.split("\n").slice(0, 3).join(" | ")}`); failed++; }
}
async function expectReject(name: string, code: string, setup: () => Promise<{ r: Awaited<ReturnType<typeof run>>; calls: number; mayCall?: boolean }>) {
  await test(name, async () => {
    const { r, calls, mayCall } = await setup();
    if (r.state !== "rejected" || r.rejection?.code !== code) return `got ${r.state} ${r.rejection?.code}: ${r.rejection?.detail}`;
    if (!mayCall && calls !== 0) return `reviewer was called ${calls} time(s)`;
    return null;
  });
}

// ---------------- adapter ----------------

await test("A01 happy path: one call, valid v3 review with exact founder_decision template, usage-based cost", async () => {
  const w = makeWorld(); const c = ok(w);
  const r = await run(w, c);
  if (r.state !== "review_written") return `state ${r.state} ${r.rejection?.code} ${r.rejection?.detail}`;
  if (c.calls !== 1) return `calls ${c.calls}`;
  const review = readOut(w, "chatgpt-review.yaml");
  const doc = YAML.parse(review);
  const ve = validateReview(doc);
  if (ve.length) return ve.join("; ");
  if (!review.endsWith(FOUNDER_DECISION_TEMPLATE)) return "founder_decision template not verbatim";
  if (doc.reviewed_commit !== w.head || doc.gate !== GATE) return "identity not carried";
  const call = r.provenance.call;
  if (!call.made || call.cost_usd !== 0.006 || call.usage_reported !== true) return `call ${JSON.stringify(call)}`;
  const req = JSON.parse(readOut(w, "review-request.json"));
  return req.base_commit === w.master && req.head_commit === w.head && req.changed_files.join() === `.agents/review-ready/${GATE}.yaml,docs/change.md` ? null : `request ${JSON.stringify(req)}`;
});

await expectReject("A02 AGENTS.md without Gate 005F section 6.6 -> E_POLICY_NOT_AUTHORIZED, no call", "E_POLICY_NOT_AUTHORIZED", async () => {
  const w = makeWorld({ authorized: false }); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await expectReject("A03 CBC_REVIEWER_ENABLED not 'enabled' -> E_REVIEWER_DISABLED", "E_REVIEWER_DISABLED", async () => {
  const w = makeWorld(); const c = ok(w); return { r: await run(w, c, { ...ENV_OK, CBC_REVIEWER_ENABLED: "true" }), calls: c.calls };
});
await expectReject("A04 Vercel policy not verified -> E_VERCEL_POLICY_UNVERIFIED", "E_VERCEL_POLICY_UNVERIFIED", async () => {
  const w = makeWorld(); const c = ok(w); return { r: await run(w, c, { ...ENV_OK, CBC_VERCEL_POLICY_VERIFIED: undefined }), calls: c.calls };
});
await expectReject("A05 committed model_id empty -> E_MODEL_NOT_APPROVED", "E_MODEL_NOT_APPROVED", async () => {
  const w = makeWorld({ modelId: "" }); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await expectReject("A06 model alias / variable mismatch -> E_MODEL_NOT_APPROVED", "E_MODEL_NOT_APPROVED", async () => {
  const w = makeWorld(); const c = ok(w); return { r: await run(w, c, { ...ENV_OK, CBC_REVIEWER_MODEL: "test-model-latest" }), calls: c.calls };
});
await expectReject("A07 allowance variable differs from committed allowance -> E_BUDGET_STOP", "E_BUDGET_STOP", async () => {
  const w = makeWorld(); const c = ok(w); return { r: await run(w, c, { ...ENV_OK, CBC_REVIEW_MONTHLY_ALLOWANCE_USD: "200" }), calls: c.calls };
});
await expectReject("A08 head not on origin -> E_HEAD_NOT_ON_ORIGIN", "E_HEAD_NOT_ON_ORIGIN", async () => {
  const w = makeWorld(); const c = ok(w); return { r: await run(w, c, ENV_OK, "f".repeat(40)), calls: c.calls };
});
await expectReject("A09 readiness file missing at head -> E_REQUEST_MISSING", "E_REQUEST_MISSING", async () => {
  const w = makeWorld({ noReady: true }); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await expectReject("A10 readiness status in_progress -> E_REQUEST_NOT_READY", "E_REQUEST_NOT_READY", async () => {
  const w = makeWorld({ readyStatus: "in_progress" }); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await expectReject("A11 readiness carries head_commit (self-reference) -> E_REQUEST_SCHEMA", "E_REQUEST_SCHEMA", async () => {
  const w = makeWorld({ readyExtra: `head_commit: "${"a".repeat(40)}"` }); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await expectReject("A12 automation/reviews absent (ledger unverifiable) -> E_BUDGET_STOP", "E_BUDGET_STOP", async () => {
  const w = makeWorld({ initReviewBranch: false }); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await expectReject("A13 diff touches .env.example -> E_EVIDENCE_FORBIDDEN_PATH", "E_EVIDENCE_FORBIDDEN_PATH", async () => {
  const w = makeWorld({ files: { ".env.example": "X=1\n" } }); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await test("A14 secret in an allowed file -> E_EVIDENCE_SECRET_SUSPECTED; only path/line/category recorded; nothing sent", async () => {
  const w = makeWorld({ files: { "docs/notes.md": `line one\nkey = ${FAKE_AWS}\n` } }); const c = ok(w);
  const r = await run(w, c);
  if (r.rejection?.code !== "E_EVIDENCE_SECRET_SUSPECTED" || c.calls !== 0) return `got ${r.rejection?.code}, calls ${c.calls}`;
  const f = r.rejection.findings ?? [];
  if (!f.some((x) => x.path === "docs/notes.md" && x.line === 2 && x.category === "aws_access_key")) return JSON.stringify(f);
  return readOut(w, "adapter-result.json").includes(FAKE_AWS) ? "secret value leaked into adapter-result.json" : null;
});
await expectReject("A15 oversized changed file -> E_EVIDENCE_TOO_LARGE (never truncated)", "E_EVIDENCE_TOO_LARGE", async () => {
  const w = makeWorld({ files: { "docs/big.md": "x".repeat(70_000) } }); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await expectReject("A16 response not JSON -> E_RESPONSE_NOT_JSON", "E_RESPONSE_NOT_JSON", async () => {
  const w = makeWorld(); const c = client(() => ({ raw: "looks good to me", complete: true })); return { r: await run(w, c), calls: c.calls, mayCall: true };
});
await expectReject("A17 truncated/incomplete response -> E_RESPONSE_INCOMPLETE", "E_RESPONSE_INCOMPLETE", async () => {
  const w = makeWorld(); const c = client(() => ({ raw: "{", complete: false })); return { r: await run(w, c), calls: c.calls, mayCall: true };
});
await expectReject("A18 model emits founder_decision -> E_FOUNDER_DECISION_PRESENT", "E_FOUNDER_DECISION_PRESENT", async () => {
  const w = makeWorld(); const c = ok(w, { founder_decision: { status: "approved" } }); return { r: await run(w, c), calls: c.calls, mayCall: true };
});
await expectReject("A19 extra key / bad enum -> E_RESPONSE_SCHEMA", "E_RESPONSE_SCHEMA", async () => {
  const w = makeWorld(); const c = ok(w, { recommendation: "approve", extra: 1 }); return { r: await run(w, c), calls: c.calls, mayCall: true };
});
await expectReject("A20 review_target for another commit -> E_IDENTITY_MISMATCH", "E_IDENTITY_MISMATCH", async () => {
  const w = makeWorld(); const c = ok(w, { review_target: { gate: GATE, branch: BRANCH, reviewed_commit: "b".repeat(40) } }); return { r: await run(w, c), calls: c.calls, mayCall: true };
});
await expectReject("A21 branch moves during review -> E_STALE", "E_STALE", async () => {
  const w = makeWorld(); const c = client(() => { w.commitOnBranch("docs/late.md", "late\n"); return { raw: JSON.stringify(output(w)), complete: true }; });
  return { r: await run(w, c), calls: c.calls, mayCall: true };
});
await expectReject("A22 master moves during review -> E_POLICY_STALE", "E_POLICY_STALE", async () => {
  const w = makeWorld(); const c = client(() => { w.commitOnMaster("docs/other.md", "x\n"); return { raw: JSON.stringify(output(w)), complete: true }; });
  return { r: await run(w, c), calls: c.calls, mayCall: true };
});

// ---------------- publish, one call per commit, rounds, budget ----------------

await test("P01 publish appends review + ledger (no force); same head is never called twice; re-publish is idempotent", async () => {
  const w = makeWorld(); const c = ok(w);
  await run(w, c);
  const p1 = publish({ git: w.ci, outDir: w.out, gate: GATE, head: w.head, runId: "r1" });
  if (p1.alreadyPublished || !p1.ledger) return `publish ${JSON.stringify(p1)}`;
  const rb = `refs/remotes/origin/${REVIEW_BRANCH}`;
  w.ci.fetchBranch(REVIEW_BRANCH);
  for (const f of ["adapter-result.json", "review-request.json", "chatgpt-review.yaml"]) if (w.ci.showFile(rb, `reviews/${GATE}/${w.head}/${f}`) === null) return `missing ${f}`;
  const month = new Date().toISOString().slice(0, 7);
  const ledger = w.ci.showFile(rb, `ledger/${month}.jsonl`) ?? "";
  if (!ledger.includes('"cost_usd":0.006') || ledger.trim().split("\n").length !== 1) return `ledger ${ledger}`;
  const again = publish({ git: w.ci, outDir: w.out, gate: GATE, head: w.head, runId: "r1" });
  if (!again.alreadyPublished) return "re-publish was not idempotent";
  const c2 = ok(w);
  const r2 = await run(w, c2);
  return r2.rejection?.code === "E_REVIEW_EXISTS" && c2.calls === 0 ? null : `second run ${r2.rejection?.code} calls ${c2.calls}`;
});

await test("P02 round limit: three reviewed heads -> fourth head rejected E_ROUND_LIMIT without a call", async () => {
  const w = makeWorld();
  let head = w.head;
  for (let i = 1; i <= 3; i++) {
    const c = ok({ head });
    const r = await runAdapter({ git: w.ci, branch: BRANCH, head, outDir: w.out + i, client: c, env: ENV_OK, runId: `r${i}` });
    if (r.state !== "review_written") return `round ${i}: ${r.rejection?.code}`;
    publish({ git: w.ci, outDir: w.out + i, gate: GATE, head, runId: `r${i}` });
    head = w.commitOnBranch(`docs/fix${i}.md`, `fix ${i}\n`);
  }
  const c4 = ok({ head });
  const r4 = await runAdapter({ git: w.ci, branch: BRANCH, head, outDir: w.out + "4", client: c4, env: ENV_OK, runId: "r4" });
  return r4.rejection?.code === "E_ROUND_LIMIT" && c4.calls === 0 ? null : `got ${r4.rejection?.code} calls ${c4.calls}`;
});

function seedLedger(w: World, content: string) {
  const month = new Date().toISOString().slice(0, 7);
  const g = w.dev;
  g.run(["fetch", "-q", "origin", `+refs/heads/${REVIEW_BRANCH}:refs/remotes/origin/${REVIEW_BRANCH}`]);
  g.run(["checkout", "-q", "-B", "rb", `refs/remotes/origin/${REVIEW_BRANCH}`]);
  mkdirSync(path.join(g.repo, "ledger"), { recursive: true });
  writeFileSync(path.join(g.repo, "ledger", `${month}.jsonl`), content);
  g.run(["add", "ledger"]); g.run(["commit", "-q", "-m", "seed ledger"]); g.run(["push", "-q", "origin", `rb:refs/heads/${REVIEW_BRANCH}`]);
}
await expectReject("P03 month-to-date + worst case would exceed allowance -> E_BUDGET_STOP", "E_BUDGET_STOP", async () => {
  const w = makeWorld(); seedLedger(w, JSON.stringify({ cost_usd: 19.9 }) + "\n"); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await expectReject("P04 malformed ledger line -> E_BUDGET_STOP (fail closed)", "E_BUDGET_STOP", async () => {
  const w = makeWorld(); seedLedger(w, "{not json\n"); const c = ok(w); return { r: await run(w, c), calls: c.calls };
});
await test("P05 publish refuses to replace a head that already has a model call", async () => {
  const w = makeWorld();
  await run(w, ok(w)); publish({ git: w.ci, outDir: w.out, gate: GATE, head: w.head, runId: "r1" });
  const alt = path.join(w.root, "alt"); mkdirSync(alt, { recursive: true });
  const res = JSON.parse(readOut(w, "adapter-result.json")); res.provenance.finished_at = "2099-01-01T00:00:00.000Z";
  writeFileSync(path.join(alt, "adapter-result.json"), JSON.stringify(res));
  writeFileSync(path.join(alt, "chatgpt-review.yaml"), readOut(w, "chatgpt-review.yaml"));
  try { publish({ git: w.ci, outDir: alt, gate: GATE, head: w.head, runId: "r2" }); return "replacement was accepted"; } catch (e) {
    return /refusing to replace/.test((e as Error).message) ? null : (e as Error).message;
  }
});

// ---------------- Claude loop runner ----------------

async function runner(w: World, head = w.head, timeoutMs = 5000) {
  return runLoopStep({ git: w.dev, branch: BRANCH, head, outDir: path.join(w.root, "outbox"), timeoutMs, intervalMs: 1, sleep: async () => {} });
}
await test("L01 delivered recommend_changes -> exit 0 with claude-work-request.json (R1 only)", async () => {
  const w = makeWorld(); await run(w, ok(w)); publish({ git: w.ci, outDir: w.out, gate: GATE, head: w.head, runId: "r1" });
  const r = await runner(w);
  if (r.exitCode !== 0 || r.state !== "changes_requested") return JSON.stringify(r);
  const wr = JSON.parse(readFileSync(path.join(r.dir!, "claude-work-request.json"), "utf8"));
  return wr.required_changes.map((x: { id: string }) => x.id).join() === "R1" && existsSync(path.join(r.dir!, "chatgpt-review.yaml")) ? null : JSON.stringify(wr);
});
await test("L02 delivered recommend_approve -> exit 3 founder_action_required (never approval)", async () => {
  const w = makeWorld(); await run(w, ok(w, { recommendation: "recommend_approve", required_changes: [] })); publish({ git: w.ci, outDir: w.out, gate: GATE, head: w.head, runId: "r1" });
  const r = await runner(w);
  return r.exitCode === 3 && r.state === "founder_action_required" && r.reason === "review_recommends_approve" ? null : JSON.stringify(r);
});
await test("L03 delivered adapter rejection -> exit 3 with founder-action.json naming the code", async () => {
  const w = makeWorld(); await run(w, ok(w), { ...ENV_OK, CBC_REVIEWER_ENABLED: "no" }); publish({ git: w.ci, outDir: w.out, gate: GATE, head: w.head, runId: "r1" });
  const r = await runner(w);
  return r.exitCode === 3 && r.reason === "adapter_rejected:E_REVIEWER_DISABLED" ? null : JSON.stringify(r);
});
await test("L04 nothing delivered -> exit 4 timeout", async () => {
  const w = makeWorld(); const r = await runner(w, w.head, 0);
  return r.exitCode === 4 && r.state === "timeout" ? null : JSON.stringify(r);
});

// ---------------- selection and workflow safety ----------------

await test("S01 target selection: only open, same-repo, draft gate PRs not yet published", () => {
  const h = (c: string) => c.repeat(40);
  const prs = [
    { isDraft: true, isCrossRepository: false, state: "OPEN", headRefName: "gate-005z-fixture", headRefOid: h("a") },
    { isDraft: false, isCrossRepository: false, state: "OPEN", headRefName: "gate-005y-ready", headRefOid: h("b") },
    { isDraft: true, isCrossRepository: true, state: "OPEN", headRefName: "gate-005x-fork", headRefOid: h("c") },
    { isDraft: true, isCrossRepository: false, state: "OPEN", headRefName: "feature/x", headRefOid: h("d") },
    { isDraft: true, isCrossRepository: false, state: "OPEN", headRefName: "gate-005w-done", headRefOid: h("e") },
    { isDraft: true, isCrossRepository: false, state: "OPEN", headRefName: "gate-005v-$(id)", headRefOid: h("f") },
  ];
  const t = selectTargets(prs, (_g, head) => head === h("e"));
  return JSON.stringify(t) === JSON.stringify([{ branch: "gate-005z-fixture", head: h("a") }]) ? null : JSON.stringify(t);
});

await test("W01 workflows are inert, master-defined, least-privilege, and never run reviewed code", () => {
  const problems: string[] = [];
  for (const f of ["reviewer.yml", "draft-pr-sweep.yml"]) {
    const src = readFileSync(path.join(ROOT, ".github", "workflows", f), "utf8");
    const wf = YAML.parse(src);
    const on = wf.on ?? wf[true as unknown as string];
    for (const bad of ["push", "pull_request", "pull_request_review", "issue_comment"]) if (on && bad in on) problems.push(`${f}: trigger ${bad}`);
    if (JSON.stringify(wf.permissions) !== JSON.stringify({ contents: "read" })) problems.push(`${f}: top-level permissions not read-only`);
    if (/\bnpx\b/.test(src)) problems.push(`${f}: uses npx`);
    if (/\$\{\{\s*github\.event\.pull_request\.head/.test(src)) problems.push(`${f}: interpolates PR head`);
    for (const [name, job] of Object.entries(wf.jobs as Record<string, Record<string, unknown>>)) {
      const steps = job.steps as Array<Record<string, unknown>>;
      if (!String(job.if ?? "").includes("needs.") && !/vars\.CBC_[A-Z_]+_ENABLED == 'enabled'/.test(String(job.if ?? ""))) problems.push(`${f}/${name}: not gated by an enable variable`);
      for (const s of steps) {
        const w = (s.with ?? {}) as Record<string, unknown>;
        if (String(s.uses ?? "").startsWith("actions/checkout") && w.ref !== "master") problems.push(`${f}/${name}: checkout ref is not master`);
        if (String(s.uses ?? "").startsWith("actions/setup-node") && w["node-version"] !== "24.14.0") problems.push(`${f}/${name}: node not pinned`);
        if (typeof s.run === "string" && /npm (install|i |ci(?! --ignore-scripts))/.test(s.run)) problems.push(`${f}/${name}: npm without --ignore-scripts`);
      }
      const usesSecret = JSON.stringify(job).includes("secrets.CBC_REVIEWER_API_KEY");
      if (usesSecret && (f !== "reviewer.yml" || name !== "review" || job.environment !== "cbc-reviewer")) problems.push(`${f}/${name}: secret outside the review job/environment`);
      if (usesSecret) {
        const withSecret = steps.filter((s) => JSON.stringify(s).includes("secrets.CBC_REVIEWER_API_KEY"));
        if (withSecret.length !== 1 || !String(withSecret[0].name ?? "").startsWith("Review")) problems.push(`${f}/${name}: secret exposed to ${withSecret.length} steps`);
      }
    }
  }
  return problems.length ? problems.join("; ") : null;
});

for (const r of roots) rmSync(r, { recursive: true, force: true });
console.log(`\n=== Gate 005G reviewer: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
