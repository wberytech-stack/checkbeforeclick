// Static safety checks for the Gate 009B workflows. Offline: reads files only.
// Run: node scripts/agent-collab/test-workflow-safety.mjs
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const FORBIDDEN_TRIGGERS = ["pull_request_target", "push", "issue_comment", "issues", "pull_request_review_comment", "schedule", "workflow_run", "workflow_call", "repository_dispatch", "release", "check_run", "label", "create", "delete"];

// Roles decide what a job may hold. The point: the model never shares a job with the App key.
const ROLES = {
  verify: { environment: null, secrets: [], perms: { contents: ["read"], "pull-requests": ["read"], issues: ["read"] }, claude: false, appToken: false, persistCreds: false },
  edit: { environment: "agent-model", secrets: ["ANTHROPIC_API_KEY"], perms: { contents: ["read"] }, claude: true, appToken: false, persistCreds: false },
  publish: { environment: "agent-publisher", secrets: ["CBC_APP_PRIVATE_KEY"], perms: { contents: ["read"], "pull-requests": ["read"], issues: ["read"] }, claude: false, appToken: true, persistCreds: true },
  identity: { environment: "agent-publisher", secrets: ["CBC_APP_PRIVATE_KEY"], perms: { contents: ["read"] }, claude: false, appToken: true, persistCreds: false },
  router: { environment: null, secrets: [], perms: { actions: ["write"], contents: ["read"], "pull-requests": ["write"] }, claude: false, appToken: false, persistCreds: false, noRepoCode: true, noActions: true },
};
const POLICY = {
  ".github/workflows/agent-pilot-run.yml": {
    triggers: ["workflow_dispatch"],
    jobs: { "implement-edit": ["edit", "implement"], "implement-publish": ["publish", "implement"], "fix-verify": ["verify", "fix"], "fix-edit": ["edit", "fix"], "fix-publish": ["publish", "fix"] },
    guard: [
      'guard.mjs" inputs', ' pr --json', ' review --json', ' plan --commits', ' findings --review-json', ' tree --task', ' candidate --task', ' secrets --file',
      " marker --review", "CBC-Agent-Round", "CBC-Agent-Review", "--disallowedTools", "Re-verify right before acting", "steps.reverify.outcome",
    ],
  },
  ".github/workflows/agent-identity-test.yml": {
    triggers: ["workflow_dispatch"], jobs: { identity: ["identity", "confirm"] },
    guard: ["RUN-A1-A7", "rules/branches/master", "mergeable_state"],
  },
  ".github/workflows/agent-pilot-router.yml": {
    triggers: ["pull_request_review", "pull_request"],
    jobs: { "route-review": ["router", "pull_request_review"], "request-codex-review": ["router", "pull_request"] },
    guard: [
      '"$REVIEW_USER" = "$REVIEWER_LOGIN"', '"$REVIEW_COMMIT" = "$PR_HEAD_SHA"', '"$PR_DRAFT" = "true"', '"$PR_USER" = "${APP_SLUG}[bot]"',
      "agent/pilot-*", '"$PR_HEAD_REPO" = "$GITHUB_REPOSITORY"', '"$PILOT_ENABLED" = "enabled"', "--ref master", "agent-pilot-run.yml",
      '"$SENDER" = "${APP_SLUG}[bot]"',
    ],
  },
};
const FILES = Object.keys(POLICY);

function stripComments(text) { return text.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); }

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

function splitSteps(jobBody) { return jobBody.split(/\n      - /).slice(1).map((s) => "- " + s); }

export function check(file, text) {
  const pol = POLICY[file];
  const errs = [];
  const err = (m) => errs.push(`${file}: ${m}`);
  const lines = text.split("\n");
  const code = stripComments(text);

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
  if (!/^permissions:\s*\{\}\s*$/m.test(code)) err("top-level permissions must be {}");
  if (/id-token:/.test(code)) err("id-token permission is not needed and must not be granted");
  if (!/^concurrency:/m.test(code) && !/^    concurrency:/m.test(code)) err("no concurrency group");

  // pinned actions
  for (const m of code.matchAll(/uses:\s*([^\s@]+)@(\S+)/g)) {
    if (!/^[0-9a-f]{40}$/.test(m[2])) err(`action ${m[1]} is not pinned to a 40-hex commit (${m[2]})`);
  }
  if (/secrets:\s*inherit/.test(code)) err("secrets: inherit is forbidden");
  if (/echo[^\n]*\$\{\{\s*secrets\./.test(code)) err("secret echoed");

  // jobs
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const heads = [];
  for (let i = jobsIdx + 1; i < lines.length; i++) { const m = /^  ([a-z0-9_-]+):\s*$/.exec(lines[i]); if (m) heads.push({ name: m[1], at: i }); }
  const names = heads.map((h) => h.name).sort().join(",");
  if (names !== Object.keys(pol.jobs).sort().join(",")) err(`jobs must be exactly ${Object.keys(pol.jobs).join(",")}, found ${heads.map((h) => h.name).join(",")}`);

  heads.forEach((j, k) => {
    const spec = pol.jobs[j.name];
    if (!spec) return;
    const [roleName, gate] = spec;
    const role = ROLES[roleName];
    const end = k + 1 < heads.length ? heads[k + 1].at : lines.length;
    const body = stripComments(lines.slice(j.at, end).join("\n"));

    // explicit, separate selection: hard-disabled AND names its own mode or event
    const ifm = /^    if: \$\{\{ (.*) \}\}\s*$/m.exec(body);
    if (!ifm) err(`job ${j.name} has no if condition`);
    else {
      if (!/^false && /.test(ifm[1])) err(`job ${j.name} is not hard-disabled (must start with 'false && ')`);
      if (!ifm[1].includes(gate)) err(`job ${j.name} does not name its own condition '${gate}'`);
      const others = ["implement", "fix"].filter((m) => (gate === "implement" || gate === "fix") && m !== gate);
      for (const o of others) if (new RegExp(`inputs\\.mode == '${o}'`).test(ifm[1])) err(`job ${j.name} also selects mode ${o}`);
    }
    if (!/^    timeout-minutes: \d+/m.test(body)) err(`job ${j.name} has no timeout`);

    // environment
    const envm = /^    environment: (\S+)\s*$/m.exec(body);
    if ((envm ? envm[1] : null) !== role.environment) err(`job ${j.name} environment must be ${role.environment ?? "none"}, found ${envm ? envm[1] : "none"}`);

    // job permissions
    const permBlock = /^    permissions:\n((?:      .*\n?)+)/m.exec(body);
    const perms = {};
    if (permBlock) for (const m of permBlock[1].matchAll(/^      ([a-z-]+):\s*(\w+)\s*$/gm)) perms[m[1]] = m[2];
    if (!permBlock) err(`job ${j.name} has no explicit permissions`);
    for (const [k2, v] of Object.entries(perms)) if (!role.perms[k2] || !role.perms[k2].includes(v)) err(`job ${j.name}: permission ${k2}: ${v} is not allowed for role ${roleName}`);

    // secrets
    const used = new Set([...body.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).filter((n) => n !== "GITHUB_TOKEN"));
    for (const u of used) if (!role.secrets.includes(u)) err(`job ${j.name} (${roleName}) must not read secret ${u}`);

    // role isolation
    const hasClaude = /anthropics\/claude-code-action@/.test(body);
    const hasAppToken = /create-github-app-token@/.test(body);
    if (hasClaude && !role.claude) err(`job ${j.name} must not run the model`);
    if (!hasClaude && role.claude && roleName === "edit") err(`job ${j.name} (edit) is missing the model step`);
    if (hasAppToken && !role.appToken) err(`job ${j.name} must not mint an App token`);
    if (hasClaude && hasAppToken) err(`job ${j.name} holds both the model and the App token`);
    if (hasClaude && /CBC_APP_PRIVATE_KEY|app\.outputs\.token/.test(body)) err(`job ${j.name} gives the model job access to the App key or token`);

    // checkout credentials
    for (const st of splitSteps(body).filter((s) => /actions\/checkout@/.test(s))) {
      const persist = /persist-credentials:\s*(\w+)/.exec(st);
      if (!persist) err(`job ${j.name}: checkout does not set persist-credentials`);
      else if (persist[1] === "true" && !role.persistCreds) err(`job ${j.name}: checkout stores a credential but role ${roleName} must not`);
      if (/token:\s*\$\{\{\s*steps\./.test(st) && !role.appToken) err(`job ${j.name}: checkout uses an App token but role ${roleName} must not`);
    }

    // run blocks
    for (const b of runBlocks(body)) {
      for (const m of b.matchAll(/\$\{\{([^}]*)\}\}/g)) {
        const e = m[1].trim();
        if (/^(inputs\.|github\.event\.|github\.head_ref|github\.ref_name)/.test(e)) err(`job ${j.name}: untrusted expression in run block: ${e}`);
      }
      if (/--force|push\s+(-f|--force)|git push[^\n]*\bmaster\b|git push[^\n]*\bmain\b/.test(b)) err(`job ${j.name}: force push or push to the default branch`);
      if (/gh pr merge|\/merge\b|--auto\b/.test(b)) err(`job ${j.name}: merge or auto-merge call`);
      if (/\bset\s+-[a-z]*x[a-z]*\b|\benv\b\s*(\||$)|\bprintenv\b/.test(b)) err(`job ${j.name}: environment dump or xtrace`);
      if (role.noRepoCode && /\b(npm|npx|node|python3?|bash\s+\S+\.sh|sh\s+\S+\.sh|make)\b/.test(b)) err(`job ${j.name}: router must not execute repository code or run package tools`);
      if (roleName === "edit" && /\bgit\b/.test(b)) err(`job ${j.name}: the model job must not run git (its .git is untrusted)`);
      if (roleName === "edit" && /gh\s+api/.test(b)) err(`job ${j.name}: the model job must not call the GitHub API`);
    }
    if (role.noActions && /uses:/.test(body)) err(`job ${j.name}: router must not use any action or check out code`);

    // model step rules
    for (const st of splitSteps(body).filter((s) => /anthropics\/claude-code-action@/.test(s))) {
      if (!/--max-turns \d+/.test(st)) err(`job ${j.name}: claude step has no --max-turns`);
      const allowed = /--allowedTools "([^"]*)"/.exec(st);
      if (!allowed) err(`job ${j.name}: claude step has no --allowedTools`);
      else if (/Bash|WebFetch|WebSearch|Task/.test(allowed[1])) err(`job ${j.name}: claude allowedTools includes a command or network tool`);
      const dis = /--disallowedTools "([^"]*)"/.exec(st);
      if (!dis || !/Bash/.test(dis[1])) err(`job ${j.name}: claude step does not disallow Bash`);
      if (!/github_token:\s*\$\{\{\s*github\.token\s*\}\}/.test(st)) err(`job ${j.name}: claude step must use the read-only job token`);
      if (/allowed_non_write_users/.test(st)) err(`job ${j.name}: allowed_non_write_users must not be set`);
      const bots = /allowed_bots:\s*"([^"]*)"/.exec(st);
      if (bots && bots[1] !== "github-actions") err(`job ${j.name}: allowed_bots must be only github-actions, found ${bots[1]}`);
    }
  });

  for (const sn of pol.guard) if (!code.includes(sn)) err(`required guard is missing: ${sn}`);
  return errs;
}

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`PASS ${name}`); } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); } };
const real = Object.fromEntries(FILES.map((f) => [f, readFileSync(f, "utf8")]));
for (const f of FILES) t(`real file clean: ${f}`, () => assert.deepEqual(check(f, real[f]), []));

const RUN = FILES[0], ID = FILES[1], ROUTER = FILES[2];
const mutate = (file, name, fn, expect) => t(`mutation caught [${file.split("/").pop()}]: ${name}`, () => {
  const mutated = fn(real[file]);
  assert.notEqual(mutated, real[file], "mutation did not change the file");
  const out = check(file, mutated);
  assert.ok(out.some((e) => expect.test(e)), `expected ${expect} in ${JSON.stringify(out)}`);
});
const once = (s, a, b) => { assert.equal(s.split(a).length - 1 >= 1, true, `anchor not found: ${a}`); return s.replace(a, b); };

// triggers and structure
mutate(RUN, "add pull_request trigger", (s) => s.replace("on:\n  workflow_dispatch:", "on:\n  pull_request:\n  workflow_dispatch:"), /trigger/);
mutate(RUN, "add pull_request_review trigger", (s) => s.replace("on:\n  workflow_dispatch:", "on:\n  pull_request_review:\n  workflow_dispatch:"), /trigger/);
mutate(RUN, "add issue_comment trigger", (s) => s.replace("on:\n  workflow_dispatch:", "on:\n  issue_comment:\n  workflow_dispatch:"), /trigger/);
mutate(RUN, "remove top-level concurrency", (s) => s.replace(/concurrency:\n  group: [^\n]*\n  cancel-in-progress: false\n/, ""), /concurrency/);
mutate(RUN, "add id-token", (s) => s.replace("permissions: {}", "permissions:\n  id-token: write"), /permissions|id-token/);
mutate(RUN, "unpin an action", (s) => s.replace(/actions\/checkout@[0-9a-f]{40}/, "actions/checkout@v6"), /pinned/);
mutate(RUN, "secrets inherit", (s) => s + "\n    secrets: inherit\n", /inherit/);
mutate(RUN, "add an unexpected job", (s) => s + "\n  extra:\n    if: ${{ false }}\n    runs-on: ubuntu-latest\n    steps: []\n", /jobs must be exactly/);

// explicit separate selection (blocker: job selection)
mutate(RUN, "drop the false prefix on implement-edit", (s) => s.replace("if: ${{ false && inputs.mode == 'implement' }}", "if: ${{ inputs.mode == 'implement' }}"), /not hard-disabled/);
mutate(RUN, "make a fix job select implement", (s) => s.replace("  fix-verify:\n    if: ${{ false && inputs.mode == 'fix' }}", "  fix-verify:\n    if: ${{ false && inputs.mode == 'implement' }}"), /does not name its own condition/);
mutate(RUN, "job selects both modes", (s) => s.replace("  fix-verify:\n    if: ${{ false && inputs.mode == 'fix' }}", "  fix-verify:\n    if: ${{ false && (inputs.mode == 'fix' || inputs.mode == 'implement') }}"), /also selects mode/);
mutate(RUN, "plain true condition", (s) => s.replace("if: ${{ false && inputs.mode == 'implement' }}", "if: ${{ true }}"), /not hard-disabled|does not name/);

// credential isolation (blocker: credential isolation)
mutate(RUN, "model job gets the App key", (s) => s.replace("anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}\n          # Read-only token. The model never holds a write credential.\n          github_token: ${{ github.token }}\n          prompt: |\n            You are the implementer for pilot task ${{ inputs.task_id }}.\n", "anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}\n          github_token: ${{ secrets.CBC_APP_PRIVATE_KEY }}\n          prompt: |\n            You are the implementer for pilot task ${{ inputs.task_id }}.\n"), /must not read secret|read-only job token/);
mutate(RUN, "model job gets an App token", (s) => s.replace("          # Read-only token. The model never holds a write credential.\n          github_token: ${{ github.token }}\n          prompt: |\n            You are the implementer for pilot task ${{ inputs.task_id }}.\n", "          github_token: ${{ steps.app.outputs.token }}\n          prompt: |\n            You are the implementer for pilot task ${{ inputs.task_id }}.\n"), /read-only job token|App key or token/);
mutate(RUN, "model checkout stores a credential", (s) => s.replace("ref: ${{ inputs.expected_head_sha }}\n          fetch-depth: 1\n          persist-credentials: false", "ref: ${{ inputs.expected_head_sha }}\n          fetch-depth: 1\n          persist-credentials: true"), /stores a credential/);
mutate(RUN, "model job runs git", (s) => s.replace('cp -- "$RUNNER_TEMP/findings/review-findings.json" ./review-findings.json', 'git add -A\n          cp -- "$RUNNER_TEMP/findings/review-findings.json" ./review-findings.json'), /must not run git/);
mutate(RUN, "model job calls the API", (s) => s.replace('cp -- "$RUNNER_TEMP/findings/review-findings.json" ./review-findings.json', 'gh api repos/x/y\n          cp -- "$RUNNER_TEMP/findings/review-findings.json" ./review-findings.json'), /must not call the GitHub API/);
mutate(RUN, "model job in the publisher environment", (s) => s.replace("    environment: agent-model\n", "    environment: agent-publisher\n"), /environment must be/);
mutate(RUN, "publish job runs the model", (s) => s.replace("      - name: Mint implementer App token (short-lived)\n        id: app\n", "      - uses: anthropics/claude-code-action@4411a9e9b0283becf4b924f7bce360fd7756c78c\n        with:\n          github_token: ${{ github.token }}\n      - name: Mint implementer App token (short-lived)\n        id: app\n"), /must not run the model|holds both/);
mutate(RUN, "verify job reads the Anthropic key", (s) => s.replace("          GH_TOKEN: ${{ github.token }}\n        run: |\n          set -euo pipefail\n          cp -r scripts/agent-collab", "          GH_TOKEN: ${{ github.token }}\n          X: ${{ secrets.ANTHROPIC_API_KEY }}\n        run: |\n          set -euo pipefail\n          cp -r scripts/agent-collab"), /must not read secret/);
mutate(RUN, "verify job gets a write permission", (s) => s.replace("      pull-requests: read\n      issues: read\n    outputs:", "      pull-requests: write\n      issues: read\n    outputs:"), /not allowed for role/);
mutate(RUN, "edit job gets contents write", (s) => s.replace("    environment: agent-model\n    permissions:\n      contents: read", "    environment: agent-model\n    permissions:\n      contents: write"), /not allowed for role/);
mutate(RUN, "edit job without permissions block", (s) => s.replace("    environment: agent-model\n    permissions:\n      contents: read\n", "    environment: agent-model\n"), /no explicit permissions|not allowed|permissions/);

// model tool and actor controls
mutate(RUN, "allow Bash to claude", (s) => s.replace('--allowedTools "Read,Write,Edit,Glob,Grep"', '--allowedTools "Read,Bash"'), /command or network/);
mutate(RUN, "drop max-turns", (s) => s.replace("--max-turns 8", ""), /max-turns/);
mutate(RUN, "wildcard non-write users", (s) => s.replace('allowed_bots: "github-actions"', 'allowed_non_write_users: "*"'), /allowed_non_write_users/);
mutate(RUN, "allow every bot", (s) => s.replace('allowed_bots: "github-actions"', 'allowed_bots: "*"'), /allowed_bots/);

// run block hygiene
mutate(RUN, "inputs in run block", (s) => s.replace('BRANCH="agent/pilot-${TASK_ID}-${GITHUB_RUN_ID}"', 'BRANCH="agent/pilot-${{ inputs.task_id }}"'), /untrusted expression/);
mutate(RUN, "force push", (s) => s.replace('git push -q origin "$BRANCH"', 'git push --force origin "$BRANCH"'), /force push/);
mutate(RUN, "push to master", (s) => s.replace('git push -q origin "$BRANCH"', 'git push origin HEAD:master'), /default branch/);
mutate(RUN, "auto-merge", (s) => s.replace('-f body="Agent pilot ${TASK_ID}, round 1.', '-f x="--auto" -f body="Agent pilot ${TASK_ID}, round 1.'), /merge/);
mutate(RUN, "xtrace", (s) => s.replace("set -euo pipefail", "set -euxo pipefail"), /xtrace|environment dump/);
mutate(RUN, "remove a timeout", (s) => s.replace("    timeout-minutes: 5\n", ""), /no timeout/);

// required guards (blocker: duplicates, modes)
mutate(RUN, "drop the duplicate and round plan", (s) => s.split(" plan --commits").join(" noplan --commits"), /required guard/);
mutate(RUN, "drop the review author check", (s) => s.split(" review --json").join(" noreview --json"), /required guard/);
mutate(RUN, "drop the git-free tree and mode check", (s) => s.split(" tree --task").join(" notree --task"), /required guard/);
mutate(RUN, "drop the candidate validation", (s) => s.split(" candidate --task").join(" nocandidate --task"), /required guard/);
mutate(RUN, "drop the handled-review marker", (s) => s.split(" marker --review").join(" nomarker --review"), /required guard/);
mutate(RUN, "drop the second verification", (s) => s.split("steps.reverify.outcome").join("steps.other.outcome"), /required guard/);
mutate(RUN, "drop the review trailer", (s) => s.split("CBC-Agent-Review").join("CBC-X"), /required guard/);

// identity workflow
mutate(ID, "enable the job", (s) => s.replace("if: ${{ false && inputs.confirm == 'RUN-A1-A7' }}", "if: ${{ inputs.confirm == 'RUN-A1-A7' }}"), /not hard-disabled/);
mutate(ID, "wrong environment", (s) => s.replace("environment: agent-publisher", "environment: agent-model"), /environment must be/);

// router
mutate(ROUTER, "add a checkout", (s) => s.replace("    steps:\n      - name: Pre-filter", "    steps:\n      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803\n      - name: Pre-filter"), /must not use any action/);
mutate(ROUTER, "read a secret", (s) => s.replace("GH_TOKEN: ${{ github.token }}", "GH_TOKEN: ${{ secrets.ANTHROPIC_API_KEY }}"), /must not read secret/);
mutate(ROUTER, "use pull_request_target", (s) => s.replace("  pull_request:\n    types: [synchronize]", "  pull_request_target:\n    types: [opened]"), /trigger|pull_request_target/);
mutate(ROUTER, "add issue_comment", (s) => s.replace("on:\n", "on:\n  issue_comment:\n"), /trigger/);
mutate(ROUTER, "enable a job", (s) => s.replace("if: ${{ false && github.event_name == 'pull_request_review' }}", "if: ${{ github.event_name == 'pull_request_review' }}"), /not hard-disabled/);
mutate(ROUTER, "contents write", (s) => s.replace("      contents: read", "      contents: write"), /not allowed for role/);
mutate(ROUTER, "issues write", (s) => s.replace("      actions: write", "      issues: write"), /not allowed for role/);
mutate(ROUTER, "bind to an environment", (s) => s.replace("    timeout-minutes: 5\n", "    timeout-minutes: 5\n    environment: agent-publisher\n"), /environment must be none/);
mutate(ROUTER, "run repository code", (s) => s.replace("          ok=true\n", "          ok=true\n          node scripts/x.mjs\n"), /must not execute repository code/);
mutate(ROUTER, "drop the reviewer check", (s) => s.replace('"$REVIEW_USER" = "$REVIEWER_LOGIN"', '"$REVIEW_USER" != ""'), /required guard/);
mutate(ROUTER, "drop the head sha check", (s) => s.replace('"$REVIEW_COMMIT" = "$PR_HEAD_SHA"', 'true'), /required guard/);
mutate(ROUTER, "drop the branch prefix check", (s) => s.split("agent/pilot-*").join("*"), /required guard/);
mutate(ROUTER, "drop the kill switch", (s) => s.split('"$PILOT_ENABLED" = "enabled"').join("true"), /required guard/);
mutate(ROUTER, "untrusted expression in run block", (s) => s.replace("          ok=true\n", "          echo '${{ github.event.review.body }}'\n          ok=true\n"), /untrusted expression/);
mutate(ROUTER, "dispatch from a non-master ref", (s) => s.replace("--ref master", "--ref ${PR_HEAD_REF}"), /required guard/);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
