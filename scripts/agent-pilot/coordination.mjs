// Review-only coordination decision. Pure data transformation: no network, git, credentials or writes.
// Complements Gate 005A/005D; does not replace their policy/evidence verification.
import { validateReview } from './review.mjs';
import { TASK } from './task.mjs';

const SHA = /^[0-9a-f]{40}$/;
const OWNERS = ['openai', 'gemini'];
const isObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);

export function decideNext({ taskId, headSha, baseSha, changedFiles, reviews, corrections = 0, acceptancePassed, activeImplementation = false }) {
  const stop = (status, reason) => ({ status, reason, taskId, headSha, action: null });
  if (taskId !== TASK.id) return stop('blocked', 'UNKNOWN_TASK');
  if (!SHA.test(headSha ?? '') || !SHA.test(baseSha ?? '') || headSha === baseSha)
    return stop('blocked', 'INVALID_COMMIT_IDENTITY');
  if (!Array.isArray(changedFiles) || changedFiles.length !== 1 || changedFiles[0] !== TASK.allowedFile)
    return stop('blocked', 'OUT_OF_SCOPE');
  if (!Number.isInteger(corrections) || corrections < 0 || corrections > TASK.maxCorrections)
    return stop('blocked', 'INVALID_CORRECTION_COUNT');
  if (typeof acceptancePassed !== 'boolean' || typeof activeImplementation !== 'boolean')
    return stop('blocked', 'INVALID_STATE');
  if (activeImplementation) return stop('waiting', 'IMPLEMENTATION_IN_PROGRESS');
  if (!isObject(reviews) || Object.keys(reviews).some(k => !OWNERS.includes(k)))
    return stop('blocked', 'INVALID_REVIEW_SET');
  for (const owner of OWNERS) {
    if (reviews[owner] === undefined) continue;
    try {
      validateReview(reviews[owner], headSha);
    } catch {
      return stop('blocked', 'INVALID_OR_STALE_' + owner.toUpperCase() + '_REVIEW');
    }
  }
  const missing = OWNERS.filter(owner => reviews[owner] === undefined);
  if (missing.length) return { ...stop('waiting', 'AWAITING_INDEPENDENT_REVIEWS'), missing };
  const changes = [];
  for (const owner of OWNERS) {
    const review = reviews[owner];
    if (review.recommendation === 'recommend_reject')
      return stop('founder_action_required', 'REVIEW_REJECTED');
    if (review.recommendation === 'recommend_changes' && review.required_changes.length === 0)
      return stop('blocked', 'CHANGES_WITHOUT_FINDINGS');
    for (const f of review.required_changes) {
      if (f.founder_only || !f.in_scope) return stop('founder_action_required', 'REVIEW_ESCALATION');
      if (!changes.some(x => x.file === f.file && x.change === f.change))
        changes.push({ file: f.file, change: f.change });
    }
  }
  if (!acceptancePassed && !changes.length) return stop('blocked', 'ACCEPTANCE_FAILED_WITHOUT_ACTIONABLE_REVIEW');
  if (changes.length || !acceptancePassed) {
    if (corrections >= TASK.maxCorrections) return stop('founder_action_required', 'CORRECTION_LIMIT_REACHED');
    return { ...stop('correction_proposed', 'ACTIONABLE_REVIEW_FINDINGS'), action: {
      kind: 'claude_correction_proposal', taskId, expectedHeadSha: headSha, allowedFile: TASK.allowedFile,
      nextCorrectionNumber: corrections + 1, changes
    }};
  }
  if (OWNERS.some(owner => reviews[owner].recommendation !== 'recommend_approve'))
    return stop('blocked', 'UNRESOLVED_REVIEW');
  return stop('founder_action_required', 'REVIEWS_AND_ACCEPTANCE_PASSED');
}
