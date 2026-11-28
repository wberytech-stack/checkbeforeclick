// Offline tests for guard.mjs. No network, no secrets. Run: node scripts/agent-collab/test-guard.mjs
import assert from "node:assert/strict";
import * as g from "./guard.mjs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
const SHA = "a".repeat(40);
const goodInputs = { taskId: "cbc-doc-pilot-001", mode: "implement", ref: "refs/heads/master", actor: "founder", founderLogin: "founder", round: "1" };
const goodFix = { ...goodInputs, mode: "fix", round: "2", prNumber: "65", expectedHeadSha: SHA };
const goodPr = {
  state: "open", draft: true,
  base: { ref: "master", repo: { full_name: "o/r" } },
  head: { ref: "agent/pilot-cbc-doc-pilot-001-1", sha: SHA, repo: { full_name: "o/r" } },
  user: { login: "cbc-implementer[bot]", type: "Bot" },
};
const ALLOWED = g.TASKS["cbc-doc-pilot-001"].allowedFiles;

// dispatch inputs
t("inputs: good implement", () => assert.equal(g.validateDispatchInputs(goodInputs).ok, true));
t("inputs: good fix round 2", () => assert.equal(g.validateDispatchInputs(goodFix).ok, true));
t("inputs: good fix round 3", () => assert.equal(g.validateDispatchInputs({ ...goodFix, round: "3" }).ok, true));
t("inputs: round 4 refused", () => assert.equal(g.validateDispatchInputs({ ...goodFix, round: "4" }).ok, false));
t("inputs: unknown task refused", () => assert.equal(g.validateDispatchInputs({ ...goodInputs, taskId: "x" }).ok, false));
t("inputs: not master refused", () => assert.equal(g.validateDispatchInputs({ ...goodInputs, ref: "refs/heads/evil" }).ok, false));
t("inputs: non-founder actor refused", () => assert.equal(g.validateDispatchInputs({ ...goodInputs, actor: "someone" }).ok, false));
t("inputs: empty founder login refused", () => assert.equal(g.validateDispatchInputs({ ...goodInputs, founderLogin: "", actor: "" }).ok, false));
t("inputs: implement round 2 refused", () => assert.equal(g.validateDispatchInputs({ ...goodInputs, round: "2" }).ok, false));
t("inputs: bad pr number refused", () => assert.equal(g.validateDispatchInputs({ ...goodFix, prNumber: "1; rm -rf" }).ok, false));
t("inputs: short sha refused", () => assert.equal(g.validateDispatchInputs({ ...goodFix, expectedHeadSha: "abc" }).ok, false));
t("inputs: unknown mode refused", () => assert.equal(g.validateDispatchInputs({ ...goodInputs, mode: "merge" }).ok, false));
t("inputs: null refused", () => assert.equal(g.validateDispatchInputs(null).ok, false));

// scope
t("files: only allowlisted file", () => assert.equal(g.checkChangedFiles([{ status: "M", path: ALLOWED[0] }], ALLOWED).ok, true));
t("files: added allowlisted file", () => assert.equal(g.checkChangedFiles([{ status: "A", path: ALLOWED[0] }], ALLOWED).ok, true));
t("files: empty diff refused", () => assert.equal(g.checkChangedFiles([], ALLOWED).ok, false));
t("files: workflow file refused", () => assert.equal(g.checkChangedFiles([{ status: "M", path: ".github/workflows/x.yml" }], ALLOWED).ok, false));
t("files: package.json refused", () => assert.equal(g.checkChangedFiles([{ status: "M", path: "package.json" }], ALLOWED).ok, false));
t("files: migration refused", () => assert.equal(g.checkChangedFiles([{ status: "A", path: "infra/db/migrations/005_x.sql" }], ALLOWED).ok, false));
t("files: AGENTS.md refused", () => assert.equal(g.checkChangedFiles([{ status: "M", path: "AGENTS.md" }], ALLOWED).ok, false));
t("files: extra file alongside allowed refused", () => assert.equal(g.checkChangedFiles([{ status: "M", path: ALLOWED[0] }, { status: "A", path: "docs/other.md" }], ALLOWED).ok, false));
t("files: traversal refused", () => assert.equal(g.checkChangedFiles([{ status: "M", path: "docs/engineering/../../AGENTS.md" }], ALLOWED).ok, false));
t("files: backslash refused", () => assert.equal(g.checkChangedFiles([{ status: "M", path: "docs\\engineering\\agent-pilot-sample.md" }], ALLOWED).ok, false));
t("files: absolute refused", () => assert.equal(g.checkChangedFiles([{ status: "M", path: "/etc/passwd" }], ALLOWED).ok, false));
t("files: case variant refused", () => assert.equal(g.checkChangedFiles([{ status: "M", path: "docs/engineering/Agent-Pilot-Sample.md" }], ALLOWED).ok, false));
t("files: delete refused", () => assert.equal(g.checkChangedFiles([{ status: "D", path: ALLOWED[0] }], ALLOWED).ok, false));
t("files: rename refused", () => assert.equal(g.checkChangedFiles([{ status: "R", path: ALLOWED[0], oldPath: "docs/a.md" }], ALLOWED).ok, false));
t("files: symlink mode refused", () => assert.equal(g.checkChangedFiles([{ status: "A", path: ALLOWED[0], mode: "120000" }], ALLOWED).ok, false));
t("parseNameStatus: rename parsed", () => {
  const e = g.parseNameStatus("R100\told.md\tnew.md\nM\ta.md\n");
  assert.deepEqual(e, [{ status: "R", path: "new.md", oldPath: "old.md" }, { status: "M", path: "a.md" }]);
});

// pull request state
const ctx = { appSlug: "cbc-implementer", expectedHeadSha: SHA };
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

// round sequence
const trailer = (n) => ({ message: `docs: x\n\n${g.ROUND_TRAILER}: ${n}` });
t("round: 2 follows 1", () => assert.equal(g.checkRoundSequence([trailer(1)], 2, "cbc-doc-pilot-001").ok, true));
t("round: 3 follows 2", () => assert.equal(g.checkRoundSequence([trailer(1), trailer(2)], 3, "cbc-doc-pilot-001").ok, true));
t("round: 4 refused even after 3", () => assert.equal(g.checkRoundSequence([trailer(1), trailer(2), trailer(3)], 4, "cbc-doc-pilot-001").ok, false));
t("round: skipping refused", () => assert.equal(g.checkRoundSequence([trailer(1)], 3, "cbc-doc-pilot-001").ok, false));
t("round: repeating refused", () => assert.equal(g.checkRoundSequence([trailer(1), trailer(2)], 2, "cbc-doc-pilot-001").ok, false));
t("round: no prior round refused", () => assert.equal(g.checkRoundSequence([{ message: "docs: x" }], 2, "cbc-doc-pilot-001").ok, false));
t("round: trailer must be a whole line", () => assert.equal(g.countRounds([{ message: `see ${g.ROUND_TRAILER}: 9 in text` }]), 0));

// findings as data
const C = (o) => ({ user: { login: "codex-bot" }, commit_id: SHA, body: "fix the typo", path: "a.md", line: 3, ...o });
t("findings: keeps reviewer on head sha", () => assert.equal(g.prepareFindings([C({})], { reviewerLogin: "codex-bot", headSha: SHA }).kept, 1));
t("findings: drops other authors", () => { const r = g.prepareFindings([C({ user: { login: "rando" } })], { reviewerLogin: "codex-bot", headSha: SHA }); assert.equal(r.kept, 0); assert.equal(r.dropped, 1); });
t("findings: drops stale sha", () => assert.equal(g.prepareFindings([C({ commit_id: "c".repeat(40) })], { reviewerLogin: "codex-bot", headSha: SHA }).kept, 0));
t("findings: drops secret-like body", () => assert.equal(g.prepareFindings([C({ body: "key ghp_" + "A".repeat(30) })], { reviewerLogin: "codex-bot", headSha: SHA }).kept, 0));
t("findings: truncates long body", () => assert.equal(g.prepareFindings([C({ body: "x".repeat(5000) })], { reviewerLogin: "codex-bot", headSha: SHA }).findings[0].body.length, 2000));
t("findings: strips control chars", () => assert.equal(g.prepareFindings([C({ body: "a\u0000b\u001bc" })], { reviewerLogin: "codex-bot", headSha: SHA }).findings[0].body, "abc"));
t("findings: caps count", () => assert.equal(g.prepareFindings(Array.from({ length: 50 }, () => C({})), { reviewerLogin: "codex-bot", headSha: SHA }).kept, 20));
t("findings: output marks data", () => assert.match(g.prepareFindings([], { reviewerLogin: "x", headSha: SHA }).notice, /UNTRUSTED DATA/));
t("findings: non-array input safe", () => assert.equal(g.prepareFindings(null, { reviewerLogin: "x", headSha: SHA }).kept, 0));

// secret scan
t("secrets: private key detected", () => assert.ok(g.scanForSecrets("-----BEGIN RSA PRIVATE KEY-----").length));
t("secrets: github token detected", () => assert.ok(g.scanForSecrets("ghs_" + "a".repeat(36)).length));
t("secrets: anthropic key detected", () => assert.ok(g.scanForSecrets("sk-ant-api03-abcdefghij").length));
t("secrets: clean text passes", () => assert.equal(g.scanForSecrets("hello docs").length, 0));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
