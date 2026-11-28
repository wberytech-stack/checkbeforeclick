// Static safety checks for the Gate 009B workflows. Offline: reads files only.
// Run: node scripts/agent-collab/test-workflow-safety.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const ALLOWED_SECRETS = new Set(["CBC_APP_PRIVATE_KEY", "ANTHROPIC_API_KEY"]);
const FORBIDDEN_TRIGGERS = ["pull_request_target", "push", "issue_comment", "issues", "pull_request_review_comment", "schedule", "workflow_run", "workflow_call", "repository_dispatch", "release", "check_run", "label", "create", "delete"];

// Per-file policy. `triggers` is the exact allowed trigger set.
const POLICY = {
  ".github/workflows/agent-pilot-run.yml": {
    triggers: ["workflow_dispatch"], environment: true, secrets: true, checkout: true,
    jobPerms: { contents: ["read"] },
    snippets: [
      'guard.mjs" inputs', ' pr --json', ' review --json', ' plan --commits', ' findings --review-json', ' files --task', ' secrets --file',
      "CBC-Agent-Round", "CBC-Agent-Review", "--disallowedTools", "no_changes", "steps.verify.outputs.run_model",
    ],
  },
  ".github/workflows/agent-identity-test.yml": {
    triggers: ["workflow_dispatch"], environment: true, secrets: true, checkout: true,
    jobPerms: { contents: ["read"] },
    snippets: ["RUN-A1-A7", "rules/branches/master", "mergeable_state"],
  },
  ".github/workflows/agent-pilot-router.yml": {
    triggers: ["pull_request_review", "pull_request"], environment: false, secrets: false, checkout: false,
    jobPerms: { actions: ["write"], contents: ["read"], "pull-requests": ["write"] },
    snippets: [
      '"$REVIEW_USER" = "$REVIEWER_LOGIN"', '"$REVIEW_COMMIT" = "$PR_HEAD_SHA"', '"$PR_DRAFT" = "true"', '"$PR_USER" = "${APP_SLUG}[bot]"',
      "agent/pilot-*", '"$PR_HEAD_REPO" = "$GITHUB_REPOSITORY"', '"$PILOT_ENABLED" = "enabled"', "--ref master", "agent-pilot-run.yml",
      '"$SENDER" = "${APP_SLUG}[bot]"',
    ],
    noPrCodeExecution: true,
  },
};
const FILES = Object.keys(POLICY);

function runBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run:\s*[|>]-?\s*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === "") { body.push(l); continue; }
      if (/^(\s*)/.exec(l)[1].length <= indent) break;
      body.push(l);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

export function check(file, text) {
  const pol = POLICY[file];
  const errs = [];
  const err = (m) => errs.push(`${file}: ${m}`);
  const lines = text.split("\n");
  const code = lines.filter((l) => !/^\s*#/.test(l)).join("\n");

  // triggers: exactly the allowed set
  const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onIdx < 0) err("no on: block");
  else {
    const trig = [];
    for (let i = onIdx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      const m = /^  ([a-z_]+):/.exec(lines[i]);
      if (m) trig.push(m[1]);
    }
    const want = [...pol.triggers].sort().join(",");
    if (trig.slice().sort().join(",") !== want) err(`triggers must be exactly ${want}, found ${trig.join(",")}`);
    for (const f of FORBIDDEN_TRIGGERS) if (trig.includes(f)) err(`forbidden trigger ${f}`);
  }
  if (/pull_request_target/.test(code)) err("pull_request_target is forbidden");

  // permissions
  if (!/^permissions:\s*\{\}\s*$/m.test(code)) err("top-level permissions must be {}");
  if (/id-token:/.test(code)) err("id-token permission is not needed and must not be granted");
  for (const m of code.matchAll(/^ {6}([a-z-]+):\s*(read|write|none)\s*$/gm)) {
    const allowed = pol.jobPerms[m[1]];
    if (!allowed || !allowed.includes(m[2])) err(`job permission ${m[1]}: ${m[2]} is not allowed in this workflow`);
  }

  // jobs: disabled, timeout, concurrency, environment
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const heads = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) { const m = /^  ([a-z0-9_-]+):\s*$/.exec(lines[i]); if (m) heads.push({ name: m[1], at: i }); }
  if (heads.length === 0) err("no jobs");
  heads.forEach((j, k) => {
    const end = k + 1 < heads.length ? heads[k + 1].at : lines.length;
    const body = lines.slice(j.at, end).join("\n");
    if (!/^    if: \$\{\{ false \}\}\s*$/m.test(body)) err(`job ${j.name} is not hard-disabled with if: \${{ false }}`);
    if (!/^    timeout-minutes: \d+/m.test(body)) err(`job ${j.name} has no timeout`);
    if (!/^    concurrency:|^concurrency:/m.test(body + "\n" + code.split("\njobs:")[0])) err(`job ${j.name} has no concurrency group`);
    const hasEnv = /^    environment: agent-implementer\s*$/m.test(body);
    if (pol.environment && !hasEnv) err(`job ${j.name} is not bound to the agent-implementer environment`);
    if (!pol.environment && /^    environment:/m.test(body)) err(`job ${j.name} must not use an environment (pull request workflow, no secrets)`);
  });

  // pinned actions
  for (const m of code.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(m[2])) err(`action ${m[1]} is not pinned to a 40-hex commit (${m[2]})`);
  }
  if (!pol.checkout && /uses:/.test(code)) err("this workflow must not use any action or check out code");

  // secrets
  if (/secrets:\s*inherit/.test(code)) err("secrets: inherit is forbidden");
  for (const m of code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) {
    if (!pol.secrets) err(`this workflow must not read secrets (${m[1]})`);
    else if (m[1] !== "GITHUB_TOKEN" && !ALLOWED_SECRETS.has(m[1])) err(`unexpected secret ${m[1]}`);
  }
  if (/echo[^\n]*\$\{\{\s*secrets\./.test(code)) err("secret echoed");

  // untrusted expressions must not appear inside run blocks
  for (const b of runBlocks(code)) {
    for (const m of b.matchAll(/\$\{\{([^}]*)\}\}/g)) {
      const e = m[1].trim();
      if (/^(inputs\.|github\.event\.|github\.head_ref|github\.ref_name)/.test(e)) err(`untrusted expression in run block: ${e}`);
    }
    if (/--force|push\s+(-f|--force)|git push[^\n]*\bmaster\b|git push[^\n]*\bmain\b/.test(b)) err("force push or push to the default branch in a run block");
    if (/gh pr merge|\/merge\b|--auto\b/.test(b)) err("merge or auto-merge call in a run block");
    if (/\bset\s+-[a-z]*x[a-z]*\b|\benv\b\s*(\||$)|\bprintenv\b/.test(b)) err("environment dump or xtrace in a run block");
    if (pol.noPrCodeExecution && /\b(npm|npx|node|python3?|bash\s+\S+\.sh|sh\s+\S+\.sh|make)\b/.test(b)) err("router must not execute repository code or run package tools");
  }

  // model steps
  const claudeSteps = code.split(/\n\s*- name:/).filter((s) => /anthropics\/claude-code-action@/.test(s));
  for (const s of claudeSteps) {
    if (!/--max-turns \d+/.test(s)) err("claude step has no --max-turns");
    const allowed = /--allowedTools "([^"]*)"/.exec(s);
    if (!allowed) err("claude step has no --allowedTools");
    else if (/Bash|WebFetch|WebSearch|Task/.test(allowed[1])) err("claude allowedTools includes a command or network tool");
    const dis = /--disallowedTools "([^"]*)"/.exec(s);
    if (!dis || !/Bash/.test(dis[1])) err("claude step does not disallow Bash");
    if (!/github_token:\s*\$\{\{\s*steps\.app\.outputs\.token/.test(s)) err("claude step must use the App token");
    if (/allowed_non_write_users/.test(s)) err("allowed_non_write_users must not be set");
    const bots = /allowed_bots:\s*"([^"]*)"/.exec(s);
    if (bots && bots[1] !== "github-actions") err(`allowed_bots must be only github-actions, found ${bots[1]}`);
  }

  for (const sn of pol.snippets) if (!code.includes(sn)) err(`required guard is missing: ${sn}`);
  return errs;
}

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); } };
const real = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));
for (const f of FILES) t(`real file clean: ${f}`, () => assert.deepEqual(check(f, real[f]), []));

const RUN = FILES[0], ROUTER = FILES[2];
const mutate = (file, name, fn, expect) => t(`mutation caught [${file.split("/").pop()}]: ${name}`, () => {
  const mutated = fn(real[file]);
  assert.notEqual(mutated, real[file], "mutation did not change the file");
  const out = check(file, mutated);
  assert.ok(out.some((e) => expect.test(e)), `expected /${expect}/ in ${JSON.stringify(out)}`);
});

// privileged workflow
mutate(RUN, "add pull_request trigger", (s) => s.replace("on:\n  workflow_dispatch:", "on:\n  pull_request:\n  workflow_dispatch:"), /trigger/);
mutate(RUN, "add pull_request_review trigger", (s) => s.replace("on:\n  workflow_dispatch:", "on:\n  pull_request_review:\n  workflow_dispatch:"), /trigger/);
mutate(RUN, "add issue_comment trigger", (s) => s.replace("on:\n  workflow_dispatch:", "on:\n  issue_comment:\n  workflow_dispatch:"), /trigger/);
mutate(RUN, "enable a job", (s) => s.replace("    if: ${{ false }}", "    if: ${{ true }}"), /hard-disabled/);
mutate(RUN, "unpin an action", (s) => s.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v6"), /pinned/);
mutate(RUN, "add id-token", (s) => s.replace("permissions: {}", "permissions:\n  id-token: write"), /permissions|id-token/);
mutate(RUN, "job contents write", (s) => s.replace("      contents: read", "      contents: write"), /not allowed/);
mutate(RUN, "unexpected secret", (s) => s.replace("secrets.ANTHROPIC_API_KEY", "secrets.AZURE_CLIENT_SECRET"), /unexpected secret/);
mutate(RUN, "secrets inherit", (s) => s + "\n    secrets: inherit\n", /inherit/);
mutate(RUN, "allow Bash to claude", (s) => s.replace('--allowedTools "Read,Write,Edit,Glob,Grep"', '--allowedTools "Read,Bash"'), /command or network/);
mutate(RUN, "drop max-turns", (s) => s.replace("--max-turns 8", ""), /max-turns/);
mutate(RUN, "wildcard non-write users", (s) => s.replace('allowed_bots: "github-actions"', 'allowed_non_write_users: "*"'), /allowed_non_write_users/);
mutate(RUN, "allow every bot", (s) => s.replace('allowed_bots: "github-actions"', 'allowed_bots: "*"'), /allowed_bots/);
mutate(RUN, "inputs in run block", (s) => s.replace('git switch -c "agent/pilot-${TASK_ID}-${GITHUB_RUN_ID}"', 'git switch -c "agent/pilot-${{ inputs.task_id }}"'), /untrusted expression/);
mutate(RUN, "force push", (s) => s.replace('git push -q origin "$BRANCH"', 'git push --force origin "$BRANCH"'), /force push/);
mutate(RUN, "push to master", (s) => s.replace('git push -q origin "$BRANCH"', 'git push origin HEAD:master'), /default branch/);
mutate(RUN, "auto-merge", (s) => s.replace('-f body="Agent pilot', '-f x="--auto" -f body="Agent pilot'), /merge/);
mutate(RUN, "remove timeout", (s) => s.replace(/    timeout-minutes: 20\n/, ""), /timeout/);
mutate(RUN, "remove job concurrency", (s) => s.replace(/    concurrency:\n      group: cbc-agent-implement\n      cancel-in-progress: false\n/, ""), /concurrency/);
mutate(RUN, "remove environment", (s) => s.replace(/    environment: agent-implementer\n/, ""), /environment/);
mutate(RUN, "xtrace", (s) => s.replace("set -euo pipefail", "set -euxo pipefail"), /xtrace|environment dump/);
mutate(RUN, "drop the duplicate-review check", (s) => s.replace(' plan --commits', ' noplan --commits'), /required guard/);
mutate(RUN, "drop the review author check", (s) => s.replace(' review --json', ' noreview --json'), /required guard/);
mutate(RUN, "drop review trailer", (s) => s.split("CBC-Agent-Review").join("CBC-X"), /required guard/);

// router
mutate(ROUTER, "add a checkout", (s) => s.replace("    steps:\n      - name: Pre-filter", "    steps:\n      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n      - name: Pre-filter"), /must not use any action/);
mutate(ROUTER, "read a secret", (s) => s.replace("GH_TOKEN: ${{ github.token }}", "GH_TOKEN: ${{ secrets.ANTHROPIC_API_KEY }}"), /must not read secrets/);
mutate(ROUTER, "use pull_request_target", (s) => s.replace("  pull_request:\n    types: [synchronize]", "  pull_request_target:\n    types: [opened]"), /trigger|pull_request_target/);
mutate(ROUTER, "add issue_comment", (s) => s.replace("on:\n", "on:\n  issue_comment:\n"), /trigger/);
mutate(ROUTER, "enable a job", (s) => s.replace("    if: ${{ false }}", "    if: ${{ true }}"), /hard-disabled/);
mutate(ROUTER, "contents write", (s) => s.replace("      contents: read", "      contents: write"), /not allowed/);
mutate(ROUTER, "issues write", (s) => s.replace("      actions: write", "      issues: write"), /not allowed/);
mutate(ROUTER, "bind to environment", (s) => s.replace("    timeout-minutes: 5\n", "    timeout-minutes: 5\n    environment: agent-implementer\n"), /must not use an environment/);
mutate(ROUTER, "run repository code", (s) => s.replace("          ok=true\n", "          ok=true\n          node scripts/x.mjs\n"), /must not execute repository code/);
mutate(ROUTER, "drop the reviewer check", (s) => s.replace('"$REVIEW_USER" = "$REVIEWER_LOGIN"', '"$REVIEW_USER" != ""'), /required guard/);
mutate(ROUTER, "drop the head sha check", (s) => s.replace('"$REVIEW_COMMIT" = "$PR_HEAD_SHA"', 'true'), /required guard/);
mutate(ROUTER, "drop the branch prefix check", (s) => s.split("agent/pilot-*").join("*"), /required guard/);
mutate(ROUTER, "drop the kill switch", (s) => s.split('"$PILOT_ENABLED" = "enabled"').join("true"), /required guard/);
mutate(ROUTER, "untrusted expression in run block", (s) => s.replace("          ok=true\n", "          echo '${{ github.event.review.body }}'\n          ok=true\n"), /untrusted expression/);
mutate(ROUTER, "dispatch from a non-master ref", (s) => s.replace("--ref master", "--ref ${PR_HEAD_REF}"), /required guard/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
