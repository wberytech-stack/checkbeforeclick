// Executes the router's real pre-filter shell blocks against synthetic event data. Offline.
// Run: node scripts/agent-collab/test-router-filter.mjs
import { readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const text = readFileSync(".github/workflows/agent-pilot-router.yml", "utf8");
function filterBlock(job) {
  const start = text.indexOf(`\n  ${job}:`);
  const next = text.indexOf("\n  request-codex-review:", start + 1);
  const section = text.slice(start, next > start && job === "route-review" ? next : undefined);
  const m = /- name: Pre-filter[^\n]*\n\s+id: filter\n\s+run: \|\n((?:\s{10}.*\n|\n)+)/.exec(section);
  assert.ok(m, `pre-filter block for ${job} not found`);
  return m[1].split("\n").map((l) => l.replace(/^ {10}/, "")).join("\n");
}
function run(job, env) {
  const dir = mkdtempSync(join(tmpdir(), "rf-"));
  const out = join(dir, "out");
  writeFileSync(out, "");
  const r = spawnSync("bash", ["-c", filterBlock(job)], { env: { PATH: process.env.PATH, GITHUB_OUTPUT: out, GITHUB_REPOSITORY: "o/r", ...env }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return /go=(true|false)/.exec(readFileSync(out, "utf8"))[1] === "true";
}

const SHA = "a".repeat(40);
const reviewOk = {
  PILOT_ENABLED: "enabled", EVENT_NAME: "pull_request_review", APP_SLUG: "cbc-implementer", REVIEWER_LOGIN: "codex[bot]",
  REVIEW_USER: "codex[bot]", REVIEW_COMMIT: SHA, PR_HEAD_SHA: SHA, PR_DRAFT: "true", PR_USER: "cbc-implementer[bot]",
  PR_HEAD_REF: "agent/pilot-cbc-doc-pilot-001-77", PR_HEAD_REPO: "o/r", PR_NUMBER: "65", REVIEW_ID: "9001",
};
const commentOk = {
  PILOT_ENABLED: "enabled", TRIGGER_MODE: "comment", EVENT_NAME: "pull_request", APP_SLUG: "cbc-implementer",
  SENDER: "cbc-implementer[bot]", PR_USER: "cbc-implementer[bot]", PR_DRAFT: "true", PR_HEAD_REF: "agent/pilot-x-1",
  PR_HEAD_REPO: "o/r", PR_NUMBER: "65", PR_HEAD_SHA: SHA,
};

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); pass++; console.log(`PASS ${n}`); } catch (e) { fail++; console.log(`FAIL ${n}: ${e.message}`); } };
const yes = (job, env) => assert.equal(run(job, env), true);
const no = (job, env) => assert.equal(run(job, env), false);

t("route: matching Codex review passes", () => yes("route-review", reviewOk));
for (const [name, patch] of Object.entries({
  "kill switch off": { PILOT_ENABLED: "" },
  "kill switch wrong": { PILOT_ENABLED: "yes" },
  "wrong event": { EVENT_NAME: "pull_request" },
  "review by a human": { REVIEW_USER: "founder" },
  "review by look-alike bot": { REVIEW_USER: "codex-evil[bot]" },
  "reviewer var unset": { REVIEWER_LOGIN: "", REVIEW_USER: "" },
  "stale review commit": { REVIEW_COMMIT: "b".repeat(40) },
  "not a draft": { PR_DRAFT: "false" },
  "PR by a human": { PR_USER: "founder" },
  "PR by another bot": { PR_USER: "dependabot[bot]" },
  "app slug unset": { APP_SLUG: "" },
  "non-agent branch": { PR_HEAD_REF: "feature/x" },
  "agent branch prefix as suffix": { PR_HEAD_REF: "evil/agent/pilot-1" },
  "fork head": { PR_HEAD_REPO: "evil/r" },
  "pr number injection": { PR_NUMBER: "1; curl evil" },
  "review id not numeric": { REVIEW_ID: "abc" },
  "short head sha": { PR_HEAD_SHA: "abc", REVIEW_COMMIT: "abc" },
})) t(`route: refuses ${name}`, () => no("route-review", { ...reviewOk, ...patch }));

t("comment: App push on draft agent PR passes", () => yes("request-codex-review", commentOk));
for (const [name, patch] of Object.entries({
  "mode not comment": { TRIGGER_MODE: "auto" },
  "mode unset": { TRIGGER_MODE: "" },
  "kill switch off": { PILOT_ENABLED: "" },
  "push by founder": { SENDER: "founder" },
  "push by another bot": { SENDER: "other[bot]" },
  "PR by a human": { PR_USER: "founder" },
  "not a draft": { PR_DRAFT: "false" },
  "non-agent branch": { PR_HEAD_REF: "main-fix" },
  "fork head": { PR_HEAD_REPO: "evil/r" },
  "bad sha": { PR_HEAD_SHA: "zz" },
})) t(`comment: refuses ${name}`, () => no("request-codex-review", { ...commentOk, ...patch }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
