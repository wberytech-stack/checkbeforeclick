// Static safety checks for the Gate 009B workflows. Offline: reads files only.
// Run: node scripts/agent-collab/test-workflow-safety.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const FILES = [".github/workflows/agent-pilot-run.yml", ".github/workflows/agent-identity-test.yml"];
const ALLOWED_SECRETS = new Set(["CBC_APP_PRIVATE_KEY", "ANTHROPIC_API_KEY"]);
const FORBIDDEN_TRIGGERS = ["pull_request_target", "pull_request", "push", "issue_comment", "issues", "pull_request_review", "pull_request_review_comment", "schedule", "workflow_run", "workflow_call", "repository_dispatch", "release", "check_run", "label"];

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
      const ind = /^(\s*)/.exec(l)[1].length;
      if (ind <= indent) break;
      body.push(l);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

export function check(file, text) {
  const errs = [];
  const err = (m) => errs.push(`${file}: ${m}`);
  const lines = text.split("\n");
  const code = lines.filter((l) => !/^\s*#/.test(l)).join("\n");

  // triggers
  const onIdx = lines.findIndex((l) => /^on:\s*$/.test(l));
  if (onIdx < 0) err("no on: block");
  else {
    const trig = [];
    for (let i = onIdx + 1; i < lines.length; i++) {
      if (/^\S/.test(lines[i])) break;
      const m = /^  ([a-z_]+):/.exec(lines[i]);
      if (m) trig.push(m[1]);
    }
    if (trig.length !== 1 || trig[0] !== "workflow_dispatch") err(`triggers must be only workflow_dispatch, found ${trig.join(",")}`);
    for (const f of FORBIDDEN_TRIGGERS) if (trig.includes(f)) err(`forbidden trigger ${f}`);
  }
  if (/pull_request_target/.test(code)) err("pull_request_target is forbidden");

  // permissions
  if (!/^permissions:\s*\{\}\s*$/m.test(code)) err("top-level permissions must be {}");
  if (/id-token:/.test(code)) err("id-token permission is not needed and must not be granted");
  if (/^\s+(actions|checks|deployments|packages|statuses|security-events|workflows|administration):\s*(write|read)/m.test(code)) err("unexpected job permission");
  for (const m of code.matchAll(/^\s+contents:\s*(\w+)/gm)) if (m[1] !== "read") err("job-level GITHUB_TOKEN contents must be read");

  // disabled jobs, timeouts, environment
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const jobHeads = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) { const m = /^  ([a-z0-9_-]+):\s*$/.exec(lines[i]); if (m) jobHeads.push({ name: m[1], at: i }); }
  if (jobHeads.length === 0) err("no jobs");
  jobHeads.forEach((j, k) => {
    const end = k + 1 < jobHeads.length ? jobHeads[k + 1].at : lines.length;
    const body = lines.slice(j.at, end).join("\n");
    if (!/^    if: \$\{\{ false \}\}\s*$/m.test(body)) err(`job ${j.name} is not hard-disabled with if: \${{ false }}`);
    if (!/^    timeout-minutes: \d+/m.test(body)) err(`job ${j.name} has no timeout`);
    if (!/^    environment: agent-implementer\s*$/m.test(body)) err(`job ${j.name} is not bound to the agent-implementer environment`);
  });
  if (!/^concurrency:/m.test(code)) err("no concurrency group");

  // pinned actions
  for (const m of code.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(m[2])) err(`action ${m[1]} is not pinned to a 40-hex commit (${m[2]})`);
  }

  // secrets
  if (/secrets:\s*inherit/.test(code)) err("secrets: inherit is forbidden");
  for (const m of code.matchAll(/secrets\.([A-Za-z0-9_]+)/g)) if (m[1] !== "GITHUB_TOKEN" && !ALLOWED_SECRETS.has(m[1])) err(`unexpected secret ${m[1]}`);
  if (/echo[^\n]*\$\{\{\s*secrets\./.test(code)) err("secret echoed");

  // untrusted expressions must not appear inside run blocks
  for (const b of runBlocks(code)) {
    for (const m of b.matchAll(/\$\{\{([^}]*)\}\}/g)) {
      const e = m[1].trim();
      if (/^(inputs\.|github\.event\.|github\.head_ref|github\.ref_name)/.test(e)) err(`untrusted expression in run block: ${e}`);
    }
    if (/--force|push\s+(-f|--force)|git push[^\n]*\bmaster\b|git push[^\n]*\bmain\b/.test(b)) err("force push or push to the default branch in a run block");
    if (/gh (pr merge|api[^\n]*\/merge)|--auto/.test(b) && !/never call/i.test(b)) err("merge or auto-merge call in a run block");
    if (/\bset\s+-[a-z]*x[a-z]*\b|\benv\b\s*(\||$)|\bprintenv\b/.test(b)) err("environment dump or xtrace in a run block");
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
  }
  return errs;
}

// ---- run on the real files, then on mutated copies to prove the checks bite ----
let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); } };
const real = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));

for (const f of FILES) t(`real file clean: ${f}`, () => assert.deepEqual(check(f, real[f]), []));

const base = FILES[0];
const mutate = (name, fn, expect) => t(`mutation caught: ${name}`, () => {
  const out = check(base, fn(real[base]));
  assert.ok(out.some((e) => expect.test(e)), `expected /${expect}/ in ${JSON.stringify(out)}`);
});
mutate("add pull_request trigger", (s) => s.replace("on:\n  workflow_dispatch:", "on:\n  pull_request:\n  workflow_dispatch:"), /trigger/);
mutate("add issue_comment trigger", (s) => s.replace("on:\n  workflow_dispatch:", "on:\n  issue_comment:\n  workflow_dispatch:"), /trigger/);
mutate("enable a job", (s) => s.replace("    if: ${{ false }}", "    if: ${{ true }}"), /hard-disabled/);
mutate("unpin an action", (s) => s.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v6"), /pinned/);
mutate("add id-token", (s) => s.replace("permissions: {}", "permissions:\n  id-token: write"), /permissions|id-token/);
mutate("job contents write", (s) => s.replace("      contents: read", "      contents: write"), /contents must be read/);
mutate("unexpected secret", (s) => s.replace("secrets.ANTHROPIC_API_KEY", "secrets.AZURE_CLIENT_SECRET"), /unexpected secret/);
mutate("secrets inherit", (s) => s + "\n    secrets: inherit\n", /inherit/);
mutate("allow Bash to claude", (s) => s.replace('--allowedTools "Read,Write,Edit,Glob,Grep"', '--allowedTools "Read,Bash"'), /command or network/);
mutate("drop max-turns", (s) => s.replace(/--max-turns 8/, ""), /max-turns/);
mutate("inputs in run block", (s) => s.replace('git switch -c "agent/pilot-${TASK_ID}-${GITHUB_RUN_ID}"', 'git switch -c "agent/pilot-${{ inputs.task_id }}"'), /untrusted expression/);
mutate("force push", (s) => s.replace('git push -q origin "$BRANCH"', 'git push --force origin "$BRANCH"'), /force push/);
mutate("push to master", (s) => s.replace('git push -q origin "$BRANCH"', 'git push origin HEAD:master'), /default branch/);
mutate("remove timeout", (s) => s.replace(/    timeout-minutes: 20\n/, ""), /timeout/);
mutate("remove concurrency", (s) => s.replace(/concurrency:\n  group: [^\n]*\n  cancel-in-progress: false\n/, ""), /concurrency/);
mutate("remove environment", (s) => s.replace(/    environment: agent-implementer\n/, ""), /environment/);
mutate("xtrace", (s) => s.replace("set -euo pipefail", "set -euxo pipefail"), /xtrace|environment dump/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
