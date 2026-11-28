// Offline tests for guard.mjs. No network, no secrets. Run: node scripts/agent-collab/test-guard.mjs
import assert from "node:assert/strict";
import * as g from "./guard.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
const SHA = "a".repeat(40);
const TASK = "cbc-doc-pilot-001";
const impl = { taskId: TASK, mode: "implement", ref: "refs/heads/master", actor: "founder", founderLogin: "founder" };
const fix = { ...impl, mode: "fix", prNumber: "65", reviewId: "9001", expectedHeadSha: SHA, pilotEnabled: "enabled" };
const goodPr = {
  state: "open", draft: true,
  base: { ref: "master", repo: { full_name: "o/r" } },
  head: { ref: "agent/pilot-cbc-doc-pilot-001-1", sha: SHA, repo: { full_name: "o/r" } },
  user: { login: "cbc-implementer[bot]", type: "Bot" },
};
const ALLOWED = g.TASKS[TASK].allowedFiles;
const ctx = { appSlug: "cbc-implementer", expectedHeadSha: SHA };
const trailer = (n, rid) => ({ message: `docs: x\n\n${g.ROUND_TRAILER}: ${n}` + (rid ? `\n${g.REVIEW_TRAILER}: ${rid}` : "") });

// ---- dispatch inputs
t("inputs: implement by founder", () => assert.equal(g.validateDispatchInputs(impl).ok, true));
t("inputs: implement by router refused", () => assert.equal(g.validateDispatchInputs({ ...impl, actor: g.ROUTER_ACTOR }).ok, false));
t("inputs: implement by stranger refused", () => assert.equal(g.validateDispatchInputs({ ...impl, actor: "x" }).ok, false));
t("inputs: fix by founder", () => assert.equal(g.validateDispatchInputs(fix).ok, true));
t("inputs: fix by router", () => assert.equal(g.validateDispatchInputs({ ...fix, actor: g.ROUTER_ACTOR }).ok, true));
t("inputs: fix by stranger refused", () => assert.equal(g.validateDispatchInputs({ ...fix, actor: "x" }).ok, false));
t("inputs: fix by another bot refused", () => assert.equal(g.validateDispatchInputs({ ...fix, actor: "dependabot[bot]" }).ok, false));
t("inputs: kill switch off refuses fix", () => assert.equal(g.validateDispatchInputs({ ...fix, pilotEnabled: "" }).ok, false));
t("inputs: kill switch wrong value refused", () => assert.equal(g.validateDispatchInputs({ ...fix, pilotEnabled: "true" }).ok, false));
t("inputs: unknown task refused", () => assert.equal(g.validateDispatchInputs({ ...impl, taskId: "x" }).ok, false));
t("inputs: not master refused", () => assert.equal(g.validateDispatchInputs({ ...impl, ref: "refs/heads/evil" }).ok, false));
t("inputs: empty founder login never matches empty actor", () => assert.equal(g.validateDispatchInputs({ ...impl, founderLogin: "", actor: "" }).ok, false));
t("inputs: bad pr number refused", () => assert.equal(g.validateDispatchInputs({ ...fix, prNumber: "1; rm -rf" }).ok, false));
t("inputs: bad review id refused", () => assert.equal(g.validateDispatchInputs({ ...fix, reviewId: "abc" }).ok, false));
t("inputs: short sha refused", () => assert.equal(g.validateDispatchInputs({ ...fix, expectedHeadSha: "abc" }).ok, false));
t("inputs: unknown mode refused", () => assert.equal(g.validateDispatchInputs({ ...impl, mode: "merge" }).ok, false));
t("inputs: null refused", () => assert.equal(g.validateDispatchInputs(null).ok, false));

// ---- scope
const one = (status, path, extra = {}) => g.checkChangedFiles([{ status, path, ...extra }], ALLOWED);
t("files: modify allowlisted file", () => assert.equal(one("M", ALLOWED[0]).ok, true));
t("files: add allowlisted file", () => assert.equal(one("A", ALLOWED[0]).ok, true));
t("files: empty diff refused", () => assert.equal(g.checkChangedFiles([], ALLOWED).ok, false));
t("files: workflow file refused", () => assert.equal(one("M", ".github/workflows/x.yml").ok, false));
t("files: package.json refused", () => assert.equal(one("M", "package.json").ok, false));
t("files: migration refused", () => assert.equal(one("A", "infra/db/migrations/005_x.sql").ok, false));
t("files: AGENTS.md refused", () => assert.equal(one("M", "AGENTS.md").ok, false));
t("files: extra file alongside allowed refused", () => assert.equal(g.checkChangedFiles([{ status: "M", path: ALLOWED[0] }, { status: "A", path: "docs/other.md" }], ALLOWED).ok, false));
t("files: traversal refused", () => assert.equal(one("M", "docs/engineering/../../AGENTS.md").ok, false));
t("files: backslash refused", () => assert.equal(one("M", "docs\\engineering\\agent-pilot-sample.md").ok, false));
t("files: absolute refused", () => assert.equal(one("M", "/etc/passwd").ok, false));
t("files: case variant refused", () => assert.equal(one("M", "docs/engineering/Agent-Pilot-Sample.md").ok, false));
t("files: delete refused", () => assert.equal(one("D", ALLOWED[0]).ok, false));
t("files: rename refused", () => assert.equal(one("R", ALLOWED[0], { oldPath: "docs/a.md" }).ok, false));
t("files: symlink mode refused", () => assert.equal(one("A", ALLOWED[0], { mode: "120000" }).ok, false));
t("parseNameStatus: rename parsed", () => assert.deepEqual(g.parseNameStatus("R100\told.md\tnew.md\nM\ta.md\n"), [{ status: "R", path: "new.md", oldPath: "old.md" }, { status: "M", path: "a.md" }]));

// ---- pull request
t("pr: good", () => assert.equal(g.checkPullRequest(goodPr, ctx).ok, true));
t("pr: ready for review refused", () => assert.equal(g.checkPullRequest({ ...goodPr, draft: false }, ctx).ok, false));
t("pr: closed refused", () => assert.equal(g.checkPullRequest({ ...goodPr, state: "closed" }, ctx).ok, false));
t("pr: base not master refused", () => assert.equal(g.checkPullRequest({ ...goodPr, base: { ...goodPr.base, ref: "dev" } }, ctx).ok, false));
t("pr: fork refused", () => assert.equal(g.checkPullRequest({ ...goodPr, head: { ...goodPr.head, repo: { full_name: "evil/r" } } }, ctx).ok, false));
t("pr: wrong branch prefix refused", () => assert.equal(g.checkPullRequest({ ...goodPr, head: { ...goodPr.head, ref: "feature/x" } }, ctx).ok, false));
t("pr: opened by human refused", () => assert.equal(g.checkPullRequest({ ...goodPr, user: { login: "founder", type: "User" } }, ctx).ok, false));
t("pr: bot with spoofed login refused", () => assert.equal(g.checkPullRequest({ ...goodPr, user: { login: "other[bot]", type: "Bot" } }, ctx).ok, false));
t("pr: user typed login look-alike refused", () => assert.equal(g.checkPullRequest({ ...goodPr, user: { login: "cbc-implementer[bot]", type: "User" } }, ctx).ok, false));
t("pr: moved head sha refused", () => assert.equal(g.checkPullRequest({ ...goodPr, head: { ...goodPr.head, sha: "b".repeat(40) } }, ctx).ok, false));
t("pr: null refused", () => assert.equal(g.checkPullRequest(null, ctx).ok, false));

// ---- review binding
const rctx = { reviewId: "9001", reviewerLogin: "codex[bot]", headSha: SHA };
const goodReview = { id: 9001, user: { login: "codex[bot]" }, commit_id: SHA, state: "COMMENTED", body: "P1: fix X" };
t("review: good", () => assert.equal(g.checkReview(goodReview, rctx).ok, true));
t("review: other author refused", () => assert.equal(g.checkReview({ ...goodReview, user: { login: "founder" } }, rctx).ok, false));
t("review: author look-alike refused", () => assert.equal(g.checkReview({ ...goodReview, user: { login: "codex" } }, rctx).ok, false));
t("review: stale commit refused", () => assert.equal(g.checkReview({ ...goodReview, commit_id: "c".repeat(40) }, rctx).ok, false));
t("review: id mismatch refused", () => assert.equal(g.checkReview({ ...goodReview, id: 1 }, rctx).ok, false));
t("review: dismissed refused", () => assert.equal(g.checkReview({ ...goodReview, state: "DISMISSED" }, rctx).ok, false));
t("review: unset reviewer login refused", () => assert.equal(g.checkReview(goodReview, { ...rctx, reviewerLogin: "" }).ok, false));

// ---- round planning, dedup, loop limit
t("plan: first fix is round 2", () => { const p = g.planFixRound([trailer(1)], "9001", TASK); assert.equal(p.ok, true); assert.equal(p.round, 2); });
t("plan: second fix is round 3", () => { const p = g.planFixRound([trailer(1), trailer(2, "9001")], "9002", TASK); assert.equal(p.ok, true); assert.equal(p.round, 3); });
t("plan: fourth round refused (loop limit)", () => assert.equal(g.planFixRound([trailer(1), trailer(2, "9001"), trailer(3, "9002")], "9003", TASK).ok, false));
t("plan: duplicate review refused", () => assert.equal(g.planFixRound([trailer(1), trailer(2, "9001")], "9001", TASK).ok, false));
t("plan: no implementation round refused", () => assert.equal(g.planFixRound([{ message: "docs: x" }], "9001", TASK).ok, false));
t("plan: empty branch refused", () => assert.equal(g.planFixRound([], "9001", TASK).ok, false));
t("plan: unknown task refused", () => assert.equal(g.planFixRound([trailer(1)], "9001", "x").ok, false));
t("plan: trailer must be a whole line", () => assert.equal(g.countRounds([{ message: `see ${g.ROUND_TRAILER}: 9 in text` }]), 0));
t("plan: review trailer in prose is not a dedup record", () => assert.equal(g.handledReviewIds([{ message: `mention ${g.REVIEW_TRAILER}: 5 inline` }]).size, 0));
t("plan: forged high round trailer still capped", () => assert.equal(g.planFixRound([trailer(1), trailer(9)], "9001", TASK).ok, false));
t("sequence: legacy check agrees", () => assert.equal(g.checkRoundSequence([trailer(1)], 2, TASK).ok, true));
t("sequence: legacy check refuses skip", () => assert.equal(g.checkRoundSequence([trailer(1)], 3, TASK).ok, false));

// ---- findings as data
const fctx = { reviewerLogin: "codex[bot]", headSha: SHA };
const C = (o) => ({ user: { login: "codex[bot]" }, commit_id: SHA, body: "fix the typo", path: "a.md", line: 3, ...o });
const R = (o) => ({ user: { login: "codex[bot]" }, commit_id: SHA, body: "P1: summary", ...o });
t("findings: review body and inline kept", () => assert.equal(g.prepareFindings({ review: R({}), comments: [C({})] }, fctx).kept, 2));
t("findings: empty review body dropped", () => assert.equal(g.prepareFindings({ review: R({ body: "  " }), comments: [] }, fctx).kept, 0));
t("findings: drops other authors", () => { const r = g.prepareFindings({ review: null, comments: [C({ user: { login: "rando" } })] }, fctx); assert.equal(r.kept, 0); assert.equal(r.dropped, 1); });
t("findings: drops stale sha", () => assert.equal(g.prepareFindings({ comments: [C({ commit_id: "c".repeat(40) })] }, fctx).kept, 0));
t("findings: drops secret-like body", () => assert.equal(g.prepareFindings({ comments: [C({ body: "key ghp_" + "A".repeat(30) })] }, fctx).kept, 0));
t("findings: truncates long body", () => assert.equal(g.prepareFindings({ comments: [C({ body: "x".repeat(5000) })] }, fctx).findings[0].body.length, 2000));
t("findings: strips control chars", () => assert.equal(g.prepareFindings({ comments: [C({ body: "a\u0000b\u001bc" })] }, fctx).findings[0].body, "abc"));
t("findings: caps count", () => assert.equal(g.prepareFindings({ comments: Array.from({ length: 50 }, () => C({})) }, fctx).kept, 20));
t("findings: output marks data", () => assert.match(g.prepareFindings({ comments: [] }, fctx).notice, /UNTRUSTED DATA/));
t("findings: non-object input safe", () => assert.equal(g.prepareFindings(null, fctx).kept, 0));
t("findings: legacy array input still works", () => assert.equal(g.prepareFindings([C({})], fctx).kept, 1));

// ---- secret scan
t("secrets: private key detected", () => assert.ok(g.scanForSecrets("-----BEGIN RSA PRIVATE KEY-----").length));
t("secrets: github token detected", () => assert.ok(g.scanForSecrets("ghs_" + "a".repeat(36)).length));
t("secrets: anthropic key detected", () => assert.ok(g.scanForSecrets("sk-ant-api03-abcdefghij").length));
t("secrets: clean text passes", () => assert.equal(g.scanForSecrets("hello docs").length, 0));

// ---- loop simulation: Codex always finds something; the loop must still stop
t("loop: always-finding reviewer stops after round 3", () => {
  let commits = [trailer(1)];
  let reviewId = 100, runs = 0;
  for (let i = 0; i < 10; i++) {
    const plan = g.planFixRound(commits, String(reviewId), TASK);
    if (!plan.ok) break;
    runs++;
    commits = [...commits, trailer(plan.round, String(reviewId))];
    reviewId++;
  }
  assert.equal(runs, 2);
  assert.equal(g.countRounds(commits), 3);
});
t("loop: replaying every event twice runs each review once", () => {
  let commits = [trailer(1)], runs = 0;
  for (const rid of ["100", "100", "101", "101", "100"]) {
    const plan = g.planFixRound(commits, rid, TASK);
    if (!plan.ok) continue;
    runs++;
    commits = [...commits, trailer(plan.round, rid)];
  }
  assert.equal(runs, 2);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
