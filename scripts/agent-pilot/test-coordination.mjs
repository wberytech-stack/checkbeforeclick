// Offline, no provider calls. Run only with separately authorized local validation.
import assert from 'node:assert/strict';
import { decideNext } from './coordination.mjs';
import { TASK } from './task.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const review = (sha, recommendation='recommend_approve', required_changes=[]) => ({
  reviewed_commit: sha, recommendation, required_changes
});
const finding = { file: TASK.allowedFile, change: 'Add required acceptance marker', in_scope: true, founder_only: false };
const base = { taskId: TASK.id, headSha: A, baseSha: B, changedFiles: [TASK.allowedFile], corrections: 0,
  acceptancePassed: false, reviews: { openai: review(A,'recommend_changes',[finding]), gemini: review(A) } };
assert.equal(decideNext(base).status, 'correction_proposed');
assert.equal(decideNext(base).action.expectedHeadSha, A);
assert.equal(decideNext({...base, reviews: {openai: base.reviews.openai}}).status, 'waiting');
assert.equal(decideNext({...base, reviews: {...base.reviews, gemini: review(C)}}).reason, 'INVALID_OR_STALE_GEMINI_REVIEW');
assert.equal(decideNext({...base, activeImplementation: true}).reason, 'IMPLEMENTATION_IN_PROGRESS');
assert.equal(decideNext({...base, corrections: 1}).reason, 'CORRECTION_LIMIT_REACHED');
assert.equal(decideNext({...base, changedFiles:['app/page.tsx']}).reason, 'OUT_OF_SCOPE');
assert.equal(decideNext({...base, reviews: {...base.reviews, gemini: review(A,'recommend_changes',[{...finding,founder_only:true}])}}).reason, 'REVIEW_ESCALATION');
assert.equal(decideNext({...base, acceptancePassed:true, reviews:{openai:review(A),gemini:review(A)}}).reason, 'REVIEWS_AND_ACCEPTANCE_PASSED');
assert.equal(decideNext({...base, taskId:'unapproved'}).reason, 'UNKNOWN_TASK');
assert.equal(decideNext({...base, headSha:B}).reason, 'INVALID_COMMIT_IDENTITY');
assert.equal(decideNext({...base, reviews: {openai:review(A,'recommend_changes',[]),gemini:review(A)}}).reason, 'CHANGES_WITHOUT_FINDINGS');
console.log('PASS: offline coordination decision cases (no agents or workflows executed)');
