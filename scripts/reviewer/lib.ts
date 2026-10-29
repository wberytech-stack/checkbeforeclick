/**
 * Gate 005G - shared helpers for the reviewer adapter, publisher and loop runner.
 *
 * Runs with Node's built-in TypeScript support (Node >= 22.18; CI pins 24.14.0).
 * Only erasable TypeScript syntax is used. No package is fetched at runtime.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";

export const PROJECT = "cbc";
export const REVIEW_BRANCH = "automation/reviews";
export const READY_SCHEMA_VERSION = 1;
export const AUTOMATION_SCHEMA_VERSION = 1;
/** Present in AGENTS.md only once Gate 005F (automation governance) is merged. */
export const AUTHORIZATION_MARKER = "### 6.6 Automation actor and the automated review loop";

export const SHA40_RE = /^[0-9a-f]{40}$/;
export const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** gate-005g-some-name -> gate id "005G". */
export const GATE_BRANCH_RE = /^gate-(\d{3}[a-z])-[a-z0-9][a-z0-9-]{0,80}$/;
/** Exact, dated model identifier; aliases such as "latest" are refused. */
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9.-]*-\d{4}-\d{2}-\d{2}$/;

export function gateIdFromBranch(branch: string): string | null {
  const m = GATE_BRANCH_RE.exec(branch);
  return m ? m[1].toUpperCase() : null;
}

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `yaml` is a transitive, lockfile-pinned package (see Gate 005A/005E/005G docs). */
export function loadYaml(cwd: string = process.cwd()): typeof import("yaml") {
  try {
    return createRequire(path.join(cwd, "package.json"))("yaml");
  } catch {
    throw new Error("the 'yaml' package is not resolvable from this repository");
  }
}

/** Read-only-by-convention git wrapper. Callers decide which commands write. */
export class Git {
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
  constructor(repo: string, env: NodeJS.ProcessEnv = process.env) {
    this.repo = repo;
    this.env = env;
  }
  run(args: string[], input?: string | Buffer): string {
    return execFileSync("git", args, {
      cwd: this.repo, env: this.env, input, encoding: "utf8",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 120000, maxBuffer: 64 * 1024 * 1024,
    }).replace(/\n$/, "");
  }
  raw(args: string[]): Buffer {
    return execFileSync("git", args, { cwd: this.repo, env: this.env, stdio: ["ignore", "pipe", "pipe"], timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  }
  ok(args: string[]): boolean {
    try { execFileSync("git", args, { cwd: this.repo, env: this.env, stdio: "ignore", timeout: 120000 }); return true; } catch { return false; }
  }
  tryRun(args: string[]): string | null {
    try { return this.run(args); } catch { return null; }
  }
  /** SHA of refs/heads/<branch> on origin, or null if absent. Throws if the remote cannot be queried. */
  remoteHead(branch: string): string | null {
    if (!BRANCH_RE.test(branch)) throw new Error(`invalid branch name: ${branch}`);
    const out = this.run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    const line = out.split("\n").find((l) => l.endsWith(`\trefs/heads/${branch}`));
    return line ? line.split("\t")[0] : null;
  }
  fetchBranch(branch: string): boolean {
    if (!BRANCH_RE.test(branch)) throw new Error(`invalid branch name: ${branch}`);
    return this.ok(["fetch", "--no-tags", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  }
  /** Exact file content at rev (no newline trimming), or null if absent. */
  showFile(rev: string, filePath: string): string | null {
    try { return this.raw(["show", `${rev}:${filePath}`]).toString("utf8"); } catch { return null; }
  }
}

/** Review selection rule: open, same-repository, DRAFT PRs from gate branches, not yet published. */
export function selectTargets(prs: unknown, alreadyPublished: (gate: string, head: string) => boolean): Array<{ branch: string; head: string }> {
  const list = Array.isArray(prs) ? prs : [];
  const out: Array<{ branch: string; head: string }> = [];
  for (const p of list) {
    if (!isObj(p) || p.isDraft !== true || p.isCrossRepository !== false || p.state !== "OPEN") continue;
    const branch = p.headRefName, head = p.headRefOid;
    if (typeof branch !== "string" || !GATE_BRANCH_RE.test(branch) || typeof head !== "string" || !SHA40_RE.test(head)) continue;
    if (alreadyPublished(gateIdFromBranch(branch)!, head)) continue;
    out.push({ branch, head });
  }
  return out;
}

// ---------- committed automation config (.agents/automation.yaml) ----------

export interface AutomationConfig {
  model_id: string;
  max_input_tokens: number;
  max_output_tokens: number;
  max_rounds_per_gate: number;
  monthly_allowance_usd: number;
  prices: Record<string, { input: number; output: number }>;
  review_branch: string;
}

export function parseAutomationConfig(doc: unknown): { config?: AutomationConfig; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(doc)) return { errors: ["automation.yaml is not a mapping"] };
  if (doc.schema_version !== AUTOMATION_SCHEMA_VERSION) errors.push(`automation.yaml schema_version must be ${AUTOMATION_SCHEMA_VERSION}`);
  if (doc.project !== PROJECT) errors.push(`automation.yaml project must be "${PROJECT}"`);
  const r = doc.reviewer, b = doc.budget, t = doc.transport;
  if (!isObj(r) || !isObj(b) || !isObj(t)) return { errors: [...errors, "automation.yaml needs reviewer, budget and transport"] };
  const num = (v: unknown, name: string, min: number) => {
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) { errors.push(`${name} must be a number >= ${min}`); return 0; }
    return v;
  };
  const prices: AutomationConfig["prices"] = {};
  const p = b.prices_usd_per_million_tokens;
  if (!isObj(p)) errors.push("budget.prices_usd_per_million_tokens must be a mapping");
  else for (const [k, v] of Object.entries(p)) {
    if (!isObj(v) || typeof v.input !== "number" || typeof v.output !== "number" || v.input < 0 || v.output < 0) errors.push(`price for ${k} is invalid`);
    else prices[k] = { input: v.input, output: v.output };
  }
  const config: AutomationConfig = {
    model_id: typeof r.model_id === "string" ? r.model_id : "",
    max_input_tokens: num(r.max_input_tokens, "reviewer.max_input_tokens", 1000),
    max_output_tokens: num(r.max_output_tokens, "reviewer.max_output_tokens", 256),
    max_rounds_per_gate: num(r.max_rounds_per_gate, "reviewer.max_rounds_per_gate", 1),
    monthly_allowance_usd: num(b.monthly_allowance_usd, "budget.monthly_allowance_usd", 0),
    prices,
    review_branch: typeof t.review_branch === "string" ? t.review_branch : "",
  };
  if (config.review_branch !== REVIEW_BRANCH) errors.push(`transport.review_branch must be "${REVIEW_BRANCH}"`);
  return errors.length > 0 ? { errors } : { config, errors };
}

// ---------- committed readiness signal (.agents/review-ready/<gate>.yaml) ----------

export interface ReadyFile {
  gate: string;
  branch: string;
  summary: string;
  validation: { build: string; results: string[] };
  founder_only_actions_requested: unknown[];
}

export const readyPath = (gate: string) => `.agents/review-ready/${gate}.yaml`;

export function parseReady(doc: unknown, gate: string, branch: string): { ready?: ReadyFile; errors: string[]; notReady?: boolean } {
  const errors: string[] = [];
  if (!isObj(doc)) return { errors: ["readiness file is not a mapping"] };
  if (doc.schema_version !== READY_SCHEMA_VERSION) errors.push(`readiness schema_version must be ${READY_SCHEMA_VERSION}`);
  if (doc.project !== PROJECT) errors.push(`readiness project must be "${PROJECT}"`);
  if (doc.gate !== gate) errors.push(`readiness gate must be "${gate}"`);
  if (doc.branch !== branch) errors.push(`readiness branch must be "${branch}"`);
  if ("head_commit" in doc) errors.push("readiness must not contain head_commit (the reviewed head is taken from git)");
  if (typeof doc.summary !== "string" || doc.summary.trim() === "") errors.push("readiness summary is required");
  const v = doc.validation;
  if (!isObj(v) || typeof v.build !== "string" || !Array.isArray(v.results)) errors.push("readiness validation.build and validation.results are required");
  if (!Array.isArray(doc.founder_only_actions_requested)) errors.push("readiness founder_only_actions_requested must be a list");
  if (doc.status !== "ready_for_review" && doc.status !== "in_progress") errors.push("readiness status must be in_progress or ready_for_review");
  if (errors.length > 0) return { errors };
  if (doc.status !== "ready_for_review") return { errors: [], notReady: true };
  return {
    errors: [],
    ready: {
      gate, branch, summary: doc.summary as string,
      validation: { build: (v as { build: string }).build, results: ((v as { results: unknown[] }).results).map(String) },
      founder_only_actions_requested: doc.founder_only_actions_requested as unknown[],
    },
  };
}
