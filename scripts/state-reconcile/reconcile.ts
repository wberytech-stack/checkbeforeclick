/**
 * Gate 005E - Repository state reconciliation for .agents/state.yaml.
 *
 * Pure planning + application over a parsed `yaml` Document and a read-only
 * GitView. No git writes, no network, no AI calls. The current master SHA is
 * never stored in state.yaml: it is always derived from git at read time,
 * which removes the self-referential "a commit cannot record its own SHA"
 * problem.
 *
 * Fail-closed: any ambiguity (unresolvable branch, fast-forward or multiple
 * merge commits, inconsistent merged record, SHA parsed as a number, invalid
 * schema) yields errors and NO document changes.
 */
import type { Document, Node, YAMLMap, YAMLSeq } from "yaml";

export const STATE_SCHEMA_VERSION = 4;
export const PROJECT = "cbc";
export const CANONICAL_STRINGIFY = { lineWidth: 0, flowCollectionPadding: false } as const;

export interface GitView {
  /** Full SHA of master (from the configured ref prefix). */
  masterHead(): string;
  /** Full SHA of <prefix><branch>, or null if the ref does not exist. */
  branchHead(branch: string): string | null;
  /** Full SHA for a (possibly short) commit id, or null if no such commit. */
  resolve(sha: string): string | null;
  /** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
  isAncestor(ancestor: string, descendant: string): boolean;
  /** master's first-parent chain, newest first, each with its full parent list. */
  firstParentChain(): Array<{ sha: string; parents: string[] }>;
  /** Committer date of a commit as YYYY-MM-DD (deterministic, from git). */
  commitDate(sha: string): string;
  /** Best common ancestor, or null. */
  mergeBase(a: string, b: string): string | null;
  /** `git patch-id --stable` of `git diff from to`, or null when the diff is empty. */
  patchId(from: string, to: string): string | null;
}

export interface Plan {
  changes: string[];
  errors: string[];
  /** Branches that become merged in this run: branch -> { head, merge } (full SHAs). */
  newlyMerged: Array<{ branch: string; head: string; merge: string; firstParent: string; index: number }>;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const BRANCH_RE = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const SHA_KEYS = new Set(["ref", "commit", "merge_commit", "branch_head", "origin_commit", "base_commit", "head_commit"]);
const MERGED_STATUSES = new Set(["merged", "merged_binding"]);

const short = (sha: string) => sha.slice(0, 7);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Collect SHA-typed fields whose YAML value is not a string (e.g. 3e24285 parsed as Infinity). */
function nonStringShas(v: unknown, path: string, out: string[]) {
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      if (path.endsWith(".parents") && typeof x !== "string") out.push(`${path}[${i}] is ${JSON.stringify(x)}, not a quoted SHA string`);
      nonStringShas(x, `${path}[${i}]`, out);
    });
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (SHA_KEYS.has(k) && x !== undefined && typeof x !== "string") out.push(`${path}.${k} is ${JSON.stringify(x)}, not a quoted SHA string`);
      nonStringShas(x, `${path}.${k}`, out);
    }
  }
}

function branchEvidence(entry: Record<string, unknown>): string[] {
  const ev = entry.evidence;
  if (!Array.isArray(ev)) return [];
  return ev.filter((e) => isObj(e) && e.type === "branch" && typeof e.ref === "string").map((e) => (e as { ref: string }).ref);
}

export function plan(doc: Document, git: GitView): Plan {
  const changes: string[] = [];
  const errors: string[] = [];
  const newlyMerged: Plan["newlyMerged"] = [];
  const js = doc.toJS() as Record<string, unknown>;

  if (!isObj(js)) return { changes, errors: ["state.yaml is not a mapping"], newlyMerged };
  if (js.schema_version !== STATE_SCHEMA_VERSION)
    errors.push(`schema_version must be ${STATE_SCHEMA_VERSION}, got ${JSON.stringify(js.schema_version)}`);
  if (js.project !== PROJECT) errors.push(`project must be "${PROJECT}"`);
  const merged = js.merged_branches_on_master;
  const unmerged = js.unmerged_gate_branches;
  const gates = js.gates;
  if (!Array.isArray(merged)) errors.push("merged_branches_on_master must be a list");
  if (!Array.isArray(unmerged)) errors.push("unmerged_gate_branches must be a list");
  if (!isObj(gates)) errors.push("gates must be a mapping");
  nonStringShas(js, "", errors);
  if (errors.length > 0) return { changes, errors, newlyMerged };

  const mergedList = merged as Array<Record<string, unknown>>;
  const unmergedList = unmerged as Array<Record<string, unknown>>;

  // Stored master SHA is self-referential by construction -> remove (derived instead).
  const base = isObj(js.repository) && isObj((js.repository as Record<string, unknown>).integration_base)
    ? ((js.repository as Record<string, unknown>).integration_base as Record<string, unknown>)
    : null;
  if (base && ("commit" in base || "matches_origin_master" in base))
    changes.push("repository.integration_base: remove stored master SHA (derived from git at read time)");

  // Duplicates.
  const seen = new Map<string, string>();
  for (const [list, name] of [[mergedList, "merged"], [unmergedList, "unmerged"]] as const) {
    list.forEach((e, i) => {
      if (!isObj(e) || typeof e.branch !== "string") return errors.push(`${name}[${i}] has no branch`);
      if (seen.has(e.branch)) errors.push(`branch "${e.branch}" listed twice (${seen.get(e.branch)} and ${name})`);
      seen.set(e.branch, name);
    });
  }
  if (errors.length > 0) return { changes, errors, newlyMerged };

  const master = git.masterHead();
  const chain = git.firstParentChain();
  const onChain = new Map(chain.map((c) => [c.sha, c]));

  // Existing merged records must be consistent with git.
  for (const e of mergedList) {
    const method = e.merge_method ?? "merge";
    if (method !== "merge" && method !== "squash") { errors.push(`merged "${e.branch}": unknown merge_method ${JSON.stringify(e.merge_method)}`); continue; }
    const m = typeof e.merge_commit === "string" ? git.resolve(e.merge_commit) : null;
    const head = typeof e.branch_head === "string" ? git.resolve(e.branch_head) : null;
    if (!m) { errors.push(`merged "${e.branch}": merge_commit ${JSON.stringify(e.merge_commit)} not found`); continue; }
    if (!head) { errors.push(`merged "${e.branch}": branch_head ${JSON.stringify(e.branch_head)} not found (fetch refs/pull/*/head if the branch was deleted)`); continue; }
    const c = onChain.get(m);
    if (!c) { errors.push(`merged "${e.branch}": ${short(m)} is not on master's first-parent history`); continue; }
    if (method === "merge") {
      if (!c.parents.slice(1).includes(head)) errors.push(`merged "${e.branch}": ${short(m)} does not merge branch_head ${short(head)}`);
      continue;
    }
    // Squash record: a single-parent commit whose patch equals the branch's own changes.
    if (c.parents.length !== 1) { errors.push(`merged "${e.branch}": squash merge_commit ${short(m)} is not a single-parent commit`); continue; }
    if (git.isAncestor(head, master)) { errors.push(`merged "${e.branch}": recorded as squash but ${short(head)} is in master's history`); continue; }
    const mb = git.mergeBase(head, c.parents[0]);
    const branchPid = mb ? git.patchId(mb, head) : null;
    const squashPid = git.patchId(c.parents[0], m);
    if (!branchPid || !squashPid || branchPid !== squashPid)
      errors.push(`merged "${e.branch}": squash ${short(m)} does not match the patch of ${short(head)} (patch-id mismatch); not verified`);
  }

  // Unmerged entries: detect completed merges.
  unmergedList.forEach((e, index) => {
    const branch = e.branch as string;
    if (!BRANCH_RE.test(branch)) return errors.push(`unmerged "${branch}": invalid branch name`);
    let target: string | null;
    if (typeof e.commit === "string") {
      if (!SHA_RE.test(e.commit)) return errors.push(`unmerged "${branch}": commit is not a hex SHA`);
      target = git.resolve(e.commit);
      if (target === null) return; // not in this clone, so not reachable from master: still unmerged
    } else {
      target = git.branchHead(branch);
      if (target === null) return errors.push(`unmerged "${branch}": no recorded commit and branch not found; cannot decide`);
    }
    if (!git.isAncestor(target, master)) {
      // Not in master's history. A squash merge would look exactly like this, so check
      // for a single-parent commit on master's first-parent history whose patch equals
      // the branch's changes. A match is NEVER recorded automatically: fail closed and
      // ask for an explicit `merge_method: squash` record (verified on the next run).
      const mb = git.mergeBase(target, master);
      const branchPid = mb ? git.patchId(mb, target) : null;
      if (!mb || !branchPid) return; // no common history or empty change: still unmerged
      const matches: string[] = [];
      for (const c of chain) {
        if (c.sha === mb || git.isAncestor(c.sha, mb)) break;
        if (c.parents.length === 1 && git.patchId(c.parents[0], c.sha) === branchPid) matches.push(c.sha);
      }
      if (matches.length > 0) {
        errors.push(
          `unmerged "${branch}": ${short(target)} appears squash-merged into master as ${matches.map(short).join(", ")} (identical patch-id); ` +
          `not attributed automatically - record it in merged_branches_on_master with merge_method: squash`
        );
      }
      return;
    }
    const merges = chain.filter((c) => c.parents.slice(1).includes(target!));
    if (merges.length !== 1) {
      return errors.push(
        `unmerged "${branch}": ${short(target)} is in master but ${merges.length === 0 ? "no merge commit on master's first-parent history merges it (fast-forward, squash or indirect merge)" : `${merges.length} merge commits merge it`}; ambiguous`
      );
    }
    newlyMerged.push({ branch, head: target, merge: merges[0].sha, firstParent: merges[0].parents[0], index });
    changes.push(`branch "${branch}": merged via ${short(merges[0].sha)} (head ${short(target)}) -> move to merged_branches_on_master`);
  });

  // Gates whose branch evidence is (now) merged.
  const mergedBranches = new Map<string, string>();
  for (const e of mergedList) mergedBranches.set(e.branch as string, git.resolve(e.merge_commit as string) ?? "");
  for (const n of newlyMerged) mergedBranches.set(n.branch, n.merge);
  for (const [id, g] of Object.entries(gates as Record<string, unknown>)) {
    if (!isObj(g) || MERGED_STATUSES.has(g.status as string)) continue;
    const hits = branchEvidence(g).filter((b) => mergedBranches.has(b));
    if (hits.length > 1) errors.push(`gate "${id}": evidence names several merged branches; ambiguous`);
    else if (hits.length === 1) changes.push(`gate "${id}": status ${JSON.stringify(g.status)} -> merged via ${short(mergedBranches.get(hits[0])!)}`);
  }

  return { changes, errors, newlyMerged };
}

function shaNode(doc: Document, sha: string): Node {
  const n = doc.createNode(sha) as Node & { type?: string };
  n.type = "QUOTE_DOUBLE";
  return n;
}

function flowMap(doc: Document, entries: Array<[string, Node | string]>): YAMLMap {
  const m = doc.createNode({}) as YAMLMap;
  for (const [k, v] of entries) m.set(k, v);
  m.flow = true;
  return m;
}

/**
 * Applies a successful plan to the document. Call only when plan.errors is empty.
 * `dateOverride` (tests only) replaces the default verified_at, which is the
 * merge commit's committer date: output then depends only on git state, so
 * the same reconciliation always produces the same bytes on any day.
 */
export function apply(doc: Document, git: GitView, p: Plan, dateOverride?: string): void {
  const dateOf = (merge: string) => dateOverride ?? git.commitDate(merge);
  if (p.errors.length > 0) throw new Error("refusing to apply a plan with errors");

  const base = doc.getIn(["repository", "integration_base"]) as YAMLMap | undefined;
  if (base && (base.has("commit") || base.has("matches_origin_master"))) {
    base.delete("commit");
    base.delete("matches_origin_master");
    base.delete("evidence");
    base.set("commit_source", "derived: git rev-parse origin/master at read time; never stored (Gate 005E)");
  }

  const mergedSeq = doc.get("merged_branches_on_master") as YAMLSeq;
  const unmergedSeq = doc.get("unmerged_gate_branches") as YAMLSeq;
  const removeIdx = new Set<number>();
  for (const n of p.newlyMerged) {
    const src = (unmergedSeq.items[n.index] as YAMLMap).toJSON() as Record<string, unknown>;
    const entry = doc.createNode({}) as YAMLMap;
    entry.set("branch", n.branch);
    entry.set("branch_head", shaNode(doc, short(n.head)));
    entry.set("merge_commit", shaNode(doc, n.merge));
    const parents = doc.createNode([]) as YAMLSeq;
    parents.add(shaNode(doc, short(n.firstParent)));
    parents.add(shaNode(doc, short(n.head)));
    parents.flow = true;
    entry.set("parents", parents);
    if (typeof src.content === "string") entry.set("content", src.content);
    const ev = doc.createNode([]) as YAMLSeq;
    ev.add(flowMap(doc, [["type", "commit"], ["ref", shaNode(doc, short(n.merge))]]));
    ev.add(flowMap(doc, [["type", "git_log"], ["ref", `merge-base --is-ancestor ${short(n.head)} origin/master`]]));
    ev.flow = true;
    entry.set("evidence", ev);
    entry.set("verified_at", dateOf(n.merge));
    mergedSeq.add(entry);
    removeIdx.add(n.index);
  }
  unmergedSeq.items = unmergedSeq.items.filter((_, i) => !removeIdx.has(i));

  const mergedBranches = new Map<string, string>();
  for (const it of mergedSeq.items) {
    const e = (it as YAMLMap).toJSON() as Record<string, unknown>;
    const m = typeof e.merge_commit === "string" ? git.resolve(e.merge_commit) : null;
    if (m) mergedBranches.set(e.branch as string, m);
  }
  const gates = doc.get("gates") as YAMLMap;
  for (const pair of gates.items) {
    const g = pair.value as YAMLMap;
    if (!g || typeof (g as { toJSON?: unknown }).toJSON !== "function") continue;
    const js = g.toJSON() as Record<string, unknown>;
    if (!isObj(js) || MERGED_STATUSES.has(js.status as string)) continue;
    const hits = branchEvidence(js).filter((b) => mergedBranches.has(b));
    if (hits.length !== 1) continue;
    const m = mergedBranches.get(hits[0])!;
    g.set("status", "merged");
    g.set("merge_commit", shaNode(doc, short(m)));
    const ev = g.get("evidence") as YAMLSeq;
    ev.add(flowMap(doc, [["type", "commit"], ["ref", shaNode(doc, short(m))]]));
    g.set("verified_at", dateOf(m));
  }
}

export function render(doc: Document): string {
  return doc.toString(CANONICAL_STRINGIFY);
}
