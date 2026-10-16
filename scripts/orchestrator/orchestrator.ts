/**
 * Gate 005A - Orchestrator v1: Claude Code <-> ChatGPT review loop.
 *
 * Pure state machine. It reads already-parsed handoff/review documents and a
 * read-only view of the remote, and returns the next state plus payloads.
 *
 * It NEVER performs actions: no git writes, no pushes, no PR changes, no AI
 * calls, no network beyond the injected read-only remote lookup. Founder-only
 * actions (AGENTS.md section 6.3) are only ever reported, never executed.
 */

export const HANDOFF_SCHEMA_VERSION = 4;
export const REVIEW_SCHEMA_VERSION = 3;
export const PROJECT = "cbc";

export type State =
  | "no_handoff"
  | "handoff_invalid"
  | "not_ready"
  | "blocked_branch_not_on_origin"
  | "blocked_head_mismatch"
  | "awaiting_review"
  | "review_invalid"
  | "changes_requested"
  | "founder_action_required";

export interface RemoteView {
  /** Returns the full SHA of refs/heads/<branch> on origin, or null if absent. */
  branchHead(branch: string): string | null;
}

export interface RequiredChange {
  id: string;
  file: string;
  change: string;
  in_scope: boolean;
  founder_only: boolean;
}

export interface ReviewRequestPayload {
  kind: "cbc.review_request";
  schema_version: 1;
  project: string;
  gate: string;
  branch: string;
  base_commit: string;
  head_commit: string;
  summary: string;
  changed_files: unknown[];
  validation: unknown;
  delegated_actions: unknown;
  founder_only_actions_requested: unknown[];
  instructions: string;
}

export interface ClaudeWorkRequest {
  kind: "cbc.claude_work_request";
  schema_version: 1;
  project: string;
  gate: string;
  branch: string;
  base_head_commit: string;
  required_changes: RequiredChange[];
  constraints: string[];
}

export interface FounderAction {
  kind: "cbc.founder_action_required";
  schema_version: 1;
  project: string;
  gate: string | null;
  branch: string | null;
  head_commit: string | null;
  reason: string;
  items: unknown[];
}

/** Intermediate steps recorded in Result.transitions before the final state. */
export type Step =
  | "handoff_loaded"
  | "handoff_valid"
  | "status_ready_for_review"
  | "safety_checked"
  | "origin_verified"
  | "review_request_prepared"
  | "review_loaded"
  | "review_valid"
  | "review_current";

export interface Result {
  state: State;
  reason: string;
  /** Ordered trace: intermediate steps, ending with the final state. */
  transitions: Array<Step | State>;
  errors: string[];
  notes: string[];
  reviewRequest?: ReviewRequestPayload;
  workRequest?: ClaudeWorkRequest;
  founderAction?: FounderAction;
}

// Changes that touch any of these always go to the founder, even when the
// reviewer marked them in_scope and not founder_only (defense in depth).
const FOUNDER_ONLY_PATTERNS: Array<[RegExp, string]> = [
  [/\bmerge\b/i, "merge"],
  [/ready[\s-]for[\s-]review|mark (the )?pr ready|non-draft/i, "mark PR ready"],
  [/\bdeploy/i, "deploy"],
  [/\bproduction\b|\bprod\b|cbc_prod|pg-cbc-prod/i, "production access"],
  [/\bazure\b/i, "Azure access"],
  [/key ?vault/i, "Key Vault access"],
  [/\bsecret|\.env\b|environment variable|env file/i, "secrets/env change"],
  [/apply (the )?migration|run (the )?migration|infra\/db\/migrations/i, "real migration"],
  [/package(-lock)?\.json|npm (install|update|audit fix)|dependenc/i, "dependency change"],
  [/force[\s-]push|reset --hard|delete (the )?(branch|tag|pr)|drop (table|database)|history rewrite/i, "destructive action"],
  [/new gate|expand (the )?scope|scope expansion|architecture/i, "scope/architecture change"],
];

const SHA_RE = /^[0-9a-f]{7,40}$/;
// Must not start with "-" (never passed to git as an option) and no "..".
const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const PROTECTED_BRANCHES = new Set(["master", "main"]);
const RECOMMENDATIONS = new Set(["recommend_approve", "recommend_changes", "recommend_reject"]);

type Doc = Record<string, unknown>;

const isObj = (v: unknown): v is Doc => typeof v === "object" && v !== null && !Array.isArray(v);
const nonEmptyStr = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

function get(doc: Doc, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), doc);
}

export function founderOnlyHits(text: string): string[] {
  return FOUNDER_ONLY_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label);
}

export function validateHandoff(doc: unknown): string[] {
  if (!isObj(doc)) return ["handoff is not a YAML mapping"];
  const errors: string[] = [];
  if (doc.schema_version !== HANDOFF_SCHEMA_VERSION)
    errors.push(`schema_version must be ${HANDOFF_SCHEMA_VERSION}, got ${JSON.stringify(doc.schema_version)}`);
  if (doc.project !== PROJECT) errors.push(`project must be "${PROJECT}"`);
  for (const f of ["status", "gate", "branch", "base_commit", "head_commit", "summary"]) {
    if (!nonEmptyStr(doc[f])) errors.push(`missing required field: ${f}`);
  }
  if (nonEmptyStr(doc.branch) && !BRANCH_RE.test(doc.branch)) errors.push("branch has invalid characters");
  for (const f of ["head_commit", "base_commit"]) {
    if (nonEmptyStr(doc[f]) && !SHA_RE.test(doc[f] as string)) errors.push(`${f} is not a hex commit SHA`);
  }
  if (!nonEmptyStr(get(doc, "validation.build"))) errors.push("missing required field: validation.build");
  if (!Array.isArray(doc.changed_files)) errors.push("changed_files must be a list");
  if (!Array.isArray(doc.founder_only_actions_requested))
    errors.push("founder_only_actions_requested must be a list");
  if (!isObj(doc.delegated_actions)) errors.push("missing required field: delegated_actions");
  return errors;
}

export function validateReview(doc: unknown): string[] {
  if (!isObj(doc)) return ["review is not a YAML mapping"];
  const errors: string[] = [];
  if (doc.schema_version !== REVIEW_SCHEMA_VERSION)
    errors.push(`schema_version must be ${REVIEW_SCHEMA_VERSION}, got ${JSON.stringify(doc.schema_version)}`);
  if (doc.project !== PROJECT) errors.push(`project must be "${PROJECT}"`);
  for (const f of ["gate", "reviewed_commit"]) {
    if (!nonEmptyStr(doc[f])) errors.push(`missing required field: ${f}`);
  }
  if (nonEmptyStr(doc.reviewed_commit) && !SHA_RE.test(doc.reviewed_commit))
    errors.push("reviewed_commit is not a hex commit SHA");
  if (!RECOMMENDATIONS.has(doc.recommendation as string))
    errors.push(`recommendation must be one of ${[...RECOMMENDATIONS].join(", ")}`);
  if (!Array.isArray(doc.required_changes)) {
    errors.push("required_changes must be a list");
  } else {
    doc.required_changes.forEach((c, i) => {
      if (!isObj(c)) return errors.push(`required_changes[${i}] must be a mapping`);
      for (const f of ["id", "file", "change"]) {
        if (!nonEmptyStr(c[f])) errors.push(`required_changes[${i}].${f} is required`);
      }
      for (const f of ["in_scope", "founder_only"]) {
        if (typeof c[f] !== "boolean") errors.push(`required_changes[${i}].${f} must be true or false`);
      }
    });
  }
  if (get(doc, "founder_decision.recorded_by") !== "founder_only")
    errors.push("founder_decision.recorded_by must be founder_only");
  return errors;
}

const sameCommit = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);

export function evaluate(handoff: unknown | null, review: unknown | null, remote: RemoteView): Result {
  const transitions: Array<Step | State> = [];
  const step = (s: Step) => transitions.push(s);
  const notes: string[] = [];
  const done = (state: State, reason: string, extra: Partial<Result> = {}): Result => {
    transitions.push(state);
    return { state, reason, transitions, errors: [], notes, ...extra };
  };
  const founder = (h: Doc | null, reason: string, items: unknown[]): FounderAction => ({
    kind: "cbc.founder_action_required",
    schema_version: 1,
    project: PROJECT,
    gate: h ? (h.gate as string) : null,
    branch: h ? (h.branch as string) : null,
    head_commit: h ? (h.head_commit as string) : null,
    reason,
    items,
  });

  // 1-3. Read handoff, validate schema, detect status.
  if (handoff === null) return done("no_handoff", "no handoff file");
  step("handoff_loaded");
  const handoffErrors = validateHandoff(handoff);
  if (handoffErrors.length > 0) {
    return done("handoff_invalid", "handoff failed validation", { errors: handoffErrors });
  }
  step("handoff_valid");
  const h = handoff as Doc;
  if (h.status !== "ready_for_review") {
    return done("not_ready", `handoff status is "${h.status}", not ready_for_review`);
  }
  step("status_ready_for_review");

  // Safety: a handoff that reports founder-only conditions stops the loop.
  const branch = h.branch as string;
  const head = (h.head_commit as string).toLowerCase();
  const safety: string[] = [];
  if (PROTECTED_BRANCHES.has(branch)) safety.push(`handoff branch is protected branch "${branch}"`);
  if (get(h, "delegated_actions.draft_pr.is_draft") === false)
    safety.push("draft_pr.is_draft is false: marking a PR ready is founder-only");
  if (safety.length > 0) {
    return done("founder_action_required", "safety_violation", { founderAction: founder(h, "safety_violation", safety) });
  }
  step("safety_checked");

  // 4-5. Branch and commit must be on origin.
  const remoteHead = remote.branchHead(branch);
  if (remoteHead === null) {
    return done("blocked_branch_not_on_origin", `branch "${branch}" not found on origin`);
  }
  if (!sameCommit(remoteHead.toLowerCase(), head)) {
    return done("blocked_head_mismatch", `origin/${branch} is ${remoteHead}, handoff head_commit is ${head}`);
  }
  step("origin_verified");

  // 6. Review request payload.
  const reviewRequest: ReviewRequestPayload = {
    kind: "cbc.review_request",
    schema_version: 1,
    project: PROJECT,
    gate: h.gate as string,
    branch,
    base_commit: h.base_commit as string,
    head_commit: head,
    summary: h.summary as string,
    changed_files: h.changed_files as unknown[],
    validation: h.validation,
    delegated_actions: h.delegated_actions,
    founder_only_actions_requested: h.founder_only_actions_requested as unknown[],
    instructions:
      "Review per .agents/chatgpt.md. Write .agents/chatgpt-review.yaml (schema_version 3) for this " +
      "head_commit. required_changes must be strictly in gate scope; founder-only items go to " +
      "open_questions_for_founder. Do not write founder_decision. A review is never approval.",
  };
  step("review_request_prepared");

  // 7. Read review.
  if (review === null) {
    return done("awaiting_review", "no review yet", { reviewRequest });
  }
  step("review_loaded");
  const reviewErrors = validateReview(review);
  const r = review as Doc;
  if (reviewErrors.length === 0 && r.gate !== h.gate) reviewErrors.push(`review gate "${r.gate}" != handoff gate "${h.gate}"`);
  if (reviewErrors.length > 0) {
    return done("review_invalid", "review failed validation", { errors: reviewErrors, reviewRequest });
  }
  step("review_valid");
  if (!sameCommit(head, (r.reviewed_commit as string).toLowerCase())) {
    return done("awaiting_review", `review is stale (reviewed ${r.reviewed_commit}, head ${head})`, { reviewRequest });
  }
  step("review_current");
  if (get(r, "founder_decision.status") !== "pending") {
    notes.push("founder_decision is not pending; recorded for the founder only, never acted on by the orchestrator");
  }

  // 9. Approve or reject -> founder.
  if (r.recommendation === "recommend_approve") {
    return done("founder_action_required", "review_recommends_approve", {
      founderAction: founder(h, "review_recommends_approve", [
        "ChatGPT recommends approval. This is not founder approval.",
        "Founder decides whether to mark the PR ready and/or merge.",
      ]),
    });
  }
  if (r.recommendation === "recommend_reject") {
    return done("founder_action_required", "review_recommends_reject", {
      founderAction: founder(h, "review_recommends_reject", (r.open_questions_for_founder as unknown[]) ?? []),
    });
  }

  // 8. Changes requested -> split actionable vs escalated.
  const actionable: RequiredChange[] = [];
  const escalated: Array<RequiredChange & { escalation: string[] }> = [];
  for (const c of r.required_changes as RequiredChange[]) {
    const why: string[] = [];
    if (!c.in_scope) why.push("in_scope is false");
    if (c.founder_only) why.push("founder_only is true");
    why.push(...founderOnlyHits(`${c.file} ${c.change}`).map((l) => `mentions ${l}`));
    if (why.length === 0) actionable.push(c);
    else escalated.push({ ...c, escalation: why });
  }
  const openQuestions = Array.isArray(r.open_questions_for_founder) ? r.open_questions_for_founder : [];

  if (actionable.length === 0) {
    return done("founder_action_required", "no_actionable_changes", {
      founderAction: founder(h, "no_actionable_changes", [...escalated, ...openQuestions]),
    });
  }

  const workRequest: ClaudeWorkRequest = {
    kind: "cbc.claude_work_request",
    schema_version: 1,
    project: PROJECT,
    gate: h.gate as string,
    branch,
    base_head_commit: head,
    required_changes: actionable,
    constraints: [
      "Stay strictly inside the approved gate scope (AGENTS.md section 6.4).",
      "Do not perform any founder-only action (AGENTS.md section 6.3).",
      "Re-run the gate validation, commit, push only this gate branch, keep any PR in draft.",
      "Record each item in claude-handoff.yaml review_changes; set status ready_for_review when done.",
    ],
  };
  const extra: Partial<Result> = { workRequest };
  if (escalated.length > 0 || openQuestions.length > 0) {
    extra.founderAction = founder(h, "escalated_review_items", [...escalated, ...openQuestions]);
    notes.push(`${escalated.length} review item(s) escalated to the founder, not sent to Claude`);
  }
  return done("changes_requested", `${actionable.length} in-scope change(s) for Claude`, extra);
}
