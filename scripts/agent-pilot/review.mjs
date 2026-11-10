// Review adapter contract — NO model calls, credentials, or network access.
// Future OpenAI adapter must be separately approved and implemented.
export function validateReview(review, expectedSha) {
  if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error('INVALID_SHA');
  if (!review || review.reviewed_commit !== expectedSha) throw new Error('STALE_REVIEW');
  if (!['recommend_approve','recommend_changes','recommend_reject'].includes(review.recommendation)) throw new Error('INVALID_RECOMMENDATION');
  if (!Array.isArray(review.required_changes)) throw new Error('INVALID_FINDINGS');
  if ('founder_decision' in review) throw new Error('FOUNDER_DECISION_FORBIDDEN');
  for (const finding of review.required_changes) {
    if (!finding || typeof finding.file !== 'string' || typeof finding.change !== 'string' ||
        typeof finding.in_scope !== 'boolean' || typeof finding.founder_only !== 'boolean')
      throw new Error('INVALID_FINDING');
    if (finding.in_scope && !finding.founder_only &&
        finding.file !== 'docs/engineering/agent-pilot-sample.md')
      throw new Error('OUT_OF_SCOPE_FINDING');
  }
  return review;
}
export async function callOpenAIReviewer() {
  throw new Error('DISABLED: OpenAI API integration requires separate founder approval');
}
