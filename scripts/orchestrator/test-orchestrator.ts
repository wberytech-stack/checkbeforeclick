/**
 * Gate 005A - Orchestrator v1 smoke tests. Fixture YAML only: no network,
 * no git writes, no AI calls. Each case runs the real CLI with
 * --remote-fixture, so `git ls-remote` is never invoked.
 *
 *   npx --yes tsx@4.23.0 scripts/orchestrator/test-orchestrator.ts
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DIR = path.join("scripts", "orchestrator");
const FX = path.join(DIR, "fixtures");
const A = "a".repeat(40);

interface Case {
  name: string;
  handoff: string;
  review: string;
  state: string;
  exit: number;
  transitions: string[];
  files: string[];
  check?: (out: string) => string | null;
}

const H = (n: string) => path.join(FX, `handoff-${n}.yaml`);
const R = (n: string) => path.join(FX, `review-${n}.yaml`);
const NONE = path.join(FX, "does-not-exist.yaml");
const PRE = ["handoff_loaded", "handoff_valid", "status_ready_for_review", "safety_checked", "origin_verified", "review_request_prepared"];
const REVIEWED = [...PRE, "review_loaded", "review_valid", "review_current"];

const json = (out: string, f: string) => JSON.parse(readFileSync(path.join(out, f), "utf8"));

const cases: Case[] = [
  { name: "O01 no handoff file", handoff: NONE, review: NONE, state: "no_handoff", exit: 0, transitions: ["no_handoff"], files: ["result.json"] },
  { name: "O02 handoff schema_version 3 rejected", handoff: H("bad-schema"), review: NONE, state: "handoff_invalid", exit: 1,
    transitions: ["handoff_loaded", "handoff_invalid"], files: ["result.json"],
    check: (o) => (json(o, "result.json").errors.some((e: string) => e.includes("schema_version must be 4")) ? null : "schema error missing") },
  { name: "O03 handoff missing required fields", handoff: H("missing-fields"), review: NONE, state: "handoff_invalid", exit: 1,
    transitions: ["handoff_loaded", "handoff_invalid"], files: ["result.json"],
    check: (o) => {
      const e: string[] = json(o, "result.json").errors;
      return ["head_commit", "validation.build"].every((f) => e.some((x) => x.includes(f))) ? null : `errors: ${e}`;
    } },
  { name: "O04 branch name that looks like a git option rejected", handoff: H("bad-branch"), review: NONE, state: "handoff_invalid", exit: 1,
    transitions: ["handoff_loaded", "handoff_invalid"], files: ["result.json"] },
  { name: "O05 status in_progress", handoff: H("in-progress"), review: NONE, state: "not_ready", exit: 0,
    transitions: ["handoff_loaded", "handoff_valid", "not_ready"], files: ["result.json"] },
  { name: "O06 handoff on master -> founder", handoff: H("master-branch"), review: NONE, state: "founder_action_required", exit: 0,
    transitions: ["handoff_loaded", "handoff_valid", "status_ready_for_review", "founder_action_required"], files: ["result.json", "founder-action.json"],
    check: (o) => (json(o, "founder-action.json").reason === "safety_violation" ? null : "reason") },
  { name: "O07 PR not draft -> founder", handoff: H("pr-not-draft"), review: NONE, state: "founder_action_required", exit: 0,
    transitions: ["handoff_loaded", "handoff_valid", "status_ready_for_review", "founder_action_required"], files: ["result.json", "founder-action.json"] },
  { name: "O08 branch missing on origin", handoff: H("unpushed"), review: NONE, state: "blocked_branch_not_on_origin", exit: 1,
    transitions: ["handoff_loaded", "handoff_valid", "status_ready_for_review", "safety_checked", "blocked_branch_not_on_origin"], files: ["result.json"] },
  { name: "O09 origin head differs from handoff", handoff: H("head-mismatch"), review: NONE, state: "blocked_head_mismatch", exit: 1,
    transitions: ["handoff_loaded", "handoff_valid", "status_ready_for_review", "safety_checked", "blocked_head_mismatch"], files: ["result.json"] },
  { name: "O10 ready, no review -> review request", handoff: H("ready"), review: NONE, state: "awaiting_review", exit: 0,
    transitions: [...PRE, "awaiting_review"], files: ["result.json", "review-request.json"],
    check: (o) => {
      const p = json(o, "review-request.json");
      return p.kind === "cbc.review_request" && p.branch === "gate-999z-fixture" && p.head_commit === A ? null : JSON.stringify(p);
    } },
  { name: "O11 stale review (other commit)", handoff: H("ready"), review: R("stale"), state: "awaiting_review", exit: 0,
    transitions: [...PRE, "review_loaded", "review_valid", "awaiting_review"], files: ["result.json", "review-request.json"] },
  { name: "O12 review for another gate", handoff: H("ready"), review: R("wrong-gate"), state: "review_invalid", exit: 1,
    transitions: [...PRE, "review_loaded", "review_invalid"], files: ["result.json", "review-request.json"] },
  { name: "O13 review rewrote founder_decision.recorded_by", handoff: H("ready"), review: R("tampered-founder"), state: "review_invalid", exit: 1,
    transitions: [...PRE, "review_loaded", "review_invalid"], files: ["result.json", "review-request.json"] },
  { name: "O14 unknown recommendation value", handoff: H("ready"), review: R("bad-recommendation"), state: "review_invalid", exit: 1,
    transitions: [...PRE, "review_loaded", "review_invalid"], files: ["result.json", "review-request.json"] },
  { name: "O15 recommend_changes, all in scope -> Claude work request", handoff: H("ready"), review: R("changes-in-scope"), state: "changes_requested", exit: 0,
    transitions: [...REVIEWED, "changes_requested"], files: ["result.json", "claude-work-request.json"],
    check: (o) => {
      if (existsSync(path.join(o, "founder-action.json"))) return "unexpected founder-action.json";
      const w = json(o, "claude-work-request.json");
      return w.required_changes.map((c: { id: string }) => c.id).join(",") === "R1,R2" ? null : JSON.stringify(w);
    } },
  { name: "O16 recommend_changes, mixed -> R1 to Claude, R2-R5 escalated", handoff: H("ready"), review: R("changes-mixed"), state: "changes_requested", exit: 0,
    transitions: [...REVIEWED, "changes_requested"], files: ["result.json", "claude-work-request.json", "founder-action.json"],
    check: (o) => {
      const w = json(o, "claude-work-request.json");
      const f = json(o, "founder-action.json");
      const esc = f.items.filter((i: { id?: string }) => i.id).map((i: { id: string; escalation: string[] }) => `${i.id}:${i.escalation.join("+")}`);
      const ok = w.required_changes.length === 1 && w.required_changes[0].id === "R1" &&
        esc.join("|") === "R2:mentions merge|R3:mentions dependency change|R4:in_scope is false|R5:founder_only is true+mentions mark PR ready" &&
        f.items.includes("Should the yaml parser become a direct devDependency?");
      return ok ? null : JSON.stringify({ w: w.required_changes, esc });
    } },
  { name: "O17 recommend_changes, only founder-only items -> founder", handoff: H("ready"), review: R("changes-founder-only"), state: "founder_action_required", exit: 0,
    transitions: [...REVIEWED, "founder_action_required"], files: ["result.json", "founder-action.json"],
    check: (o) => (existsSync(path.join(o, "claude-work-request.json")) ? "work request must not be produced" : json(o, "founder-action.json").reason === "no_actionable_changes" ? null : "reason") },
  { name: "O18 recommend_approve -> founder_action_required", handoff: H("ready"), review: R("approve"), state: "founder_action_required", exit: 0,
    transitions: [...REVIEWED, "founder_action_required"], files: ["result.json", "founder-action.json"],
    check: (o) => (json(o, "founder-action.json").reason === "review_recommends_approve" ? null : "reason") },
  { name: "O19 approve with non-pending founder_decision -> noted, not acted on", handoff: H("ready"), review: R("approve-founder-recorded"), state: "founder_action_required", exit: 0,
    transitions: [...REVIEWED, "founder_action_required"], files: ["result.json", "founder-action.json"],
    check: (o) => (json(o, "result.json").notes.some((n: string) => n.includes("never acted on")) ? null : "note missing") },
  { name: "O20 recommend_reject -> founder_action_required", handoff: H("ready"), review: R("reject"), state: "founder_action_required", exit: 0,
    transitions: [...REVIEWED, "founder_action_required"], files: ["result.json", "founder-action.json"],
    check: (o) => (json(o, "founder-action.json").reason === "review_recommends_reject" ? null : "reason") },
];

let passed = 0;
let failed = 0;
for (const c of cases) {
  const out = mkdtempSync(path.join(tmpdir(), "cbc-orch-"));
  try {
    const r = spawnSync(process.execPath, [...process.execArgv, path.join(DIR, "cli.ts"),
      "--handoff", c.handoff, "--review", c.review, "--out", out, "--remote-fixture", path.join(FX, "remote.json")], { encoding: "utf8" });
    const problems: string[] = [];
    if (r.status !== c.exit) problems.push(`exit ${r.status} != ${c.exit} ${r.stderr}`);
    if (!existsSync(path.join(out, "result.json"))) {
      problems.push("no result.json");
    } else {
      const res = json(out, "result.json");
      if (res.state !== c.state) problems.push(`state ${res.state} != ${c.state}`);
      if (res.transitions.join(">") !== c.transitions.join(">")) problems.push(`transitions ${res.transitions.join(">")}`);
      for (const f of c.files) if (!existsSync(path.join(out, f))) problems.push(`missing ${f}`);
      const extra = c.check?.(out);
      if (extra) problems.push(extra);
    }
    if (problems.length === 0) {
      console.log(`PASS: ${c.name}: ${c.transitions.join(" -> ")}`);
      passed++;
    } else {
      console.error(`FAIL: ${c.name}: ${problems.join("; ")}`);
      failed++;
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

console.log(`\n=== Gate 005A orchestrator: ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
