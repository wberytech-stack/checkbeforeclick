/**
 * Gate 005G - reviewer CLI used by .github/workflows/reviewer.yml (and by the founder
 * for the one-time `init-review-branch`). Inert unless every activation check passes.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/reviewer/cli.ts <command> [options]
 *
 * Commands:
 *   review --branch <gate-branch> --head <sha40> --out <dir> [--run-id <id>]
 *       Runs the adapter with the OpenAI client. Exit 0 = review_written,
 *       3 = rejected (result still written for publishing), 2 = usage/environment error.
 *   publish --branch <gate-branch> --head <sha40> --out <dir> [--run-id <id>]
 *       Appends the adapter output to automation/reviews (no force). Exit 0 / 2.
 *   authorized
 *       Exit 0 when AGENTS.md at origin/master contains the Gate 005F section 6.6, else 1.
 *   check-branch <branch>
 *       Exit 0 when <branch> is a valid gate branch name, else 1 (used before any shell use).
 *   select-targets <gh-pr-json>
 *       Prints targets=<json> for $GITHUB_OUTPUT: open, same-repository, DRAFT gate PRs
 *       whose head has no published result on automation/reviews yet.
 *   init-review-branch
 *       FOUNDER-RUN, once: creates the orphan automation/reviews branch. Refuses if it exists.
 *
 * Runs with Node's built-in TypeScript support (Node >= 22.18; CI pins 24.14.0).
 */
import { runAdapter } from "./adapter.ts";
import { AUTHORIZATION_MARKER, GATE_BRANCH_RE, Git, REVIEW_BRANCH, gateIdFromBranch, selectTargets } from "./lib.ts";
import { openAiReviewerClient } from "./openai-client.ts";
import { initReviewBranch, publish } from "./publish.ts";

const [cmd, ...rest] = process.argv.slice(2);
const arg = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
const fail = (msg: string, code = 2): never => { console.error(`reviewer: ${msg}`); process.exit(code); };
const git = new Git(process.cwd());

async function main() {
  switch (cmd) {
    case "check-branch":
      process.exit(rest[0] && GATE_BRANCH_RE.test(rest[0]) ? 0 : 1);
    case "authorized": {
      git.fetchBranch("master");
      const agents = git.showFile("refs/remotes/origin/master", "AGENTS.md") ?? "";
      process.exit(agents.includes(AUTHORIZATION_MARKER) ? 0 : 1);
    }
    case "select-targets": {
      let prs: unknown = [];
      try { prs = JSON.parse(rest[0] ?? "[]"); } catch { fail("select-targets expects gh JSON"); }
      const published = git.fetchBranch(REVIEW_BRANCH) ? `refs/remotes/origin/${REVIEW_BRANCH}` : null;
      const targets = selectTargets(prs, (gate, head) =>
        published !== null && git.showFile(published, `reviews/${gate}/${head}/adapter-result.json`) !== null);
      console.log(`targets=${JSON.stringify(targets)}`);
      return;
    }
    case "init-review-branch": {
      const c = initReviewBranch(git);
      console.log(JSON.stringify({ initialized: true, commit: c }));
      return;
    }
    case "review":
    case "publish": {
      const branch = arg("branch"), head = arg("head"), out = arg("out");
      const runId = arg("run-id") ?? process.env.GITHUB_RUN_ID ?? "local";
      if (!branch || !GATE_BRANCH_RE.test(branch)) fail("--branch must be a gate branch");
      if (!head || !/^[0-9a-f]{40}$/.test(head)) fail("--head must be a 40-hex SHA");
      if (!out) fail("--out is required");
      if (cmd === "publish") {
        const r = publish({ git, outDir: out!, gate: gateIdFromBranch(branch!)!, head: head!, runId });
        console.log(JSON.stringify(r));
        return;
      }
      const result = await runAdapter({
        git, branch: branch!, head: head!, outDir: out!, client: openAiReviewerClient(), runId,
        env: {
          CBC_REVIEWER_ENABLED: process.env.CBC_REVIEWER_ENABLED,
          CBC_REVIEWER_MODEL: process.env.CBC_REVIEWER_MODEL,
          CBC_REVIEW_MONTHLY_ALLOWANCE_USD: process.env.CBC_REVIEW_MONTHLY_ALLOWANCE_USD,
          CBC_VERCEL_POLICY_VERIFIED: process.env.CBC_VERCEL_POLICY_VERIFIED,
        },
      });
      console.log(JSON.stringify({ state: result.state, rejection: result.rejection?.code ?? null, transitions: result.transitions }));
      process.exit(result.state === "review_written" ? 0 : 3);
    }
    default:
      fail("usage: review | publish | authorized | check-branch | select-targets | init-review-branch");
  }
}

main().catch((e) => fail((e as Error).message.split("\n")[0]));
