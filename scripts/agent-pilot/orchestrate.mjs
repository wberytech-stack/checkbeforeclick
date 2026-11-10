// Offline, deterministic state-machine prototype. NO GitHub or AI calls.
// This is a reviewable scaffold, not a functioning autonomous agent loop.
import { verify } from './verify.mjs';
import { validateReview } from './review.mjs';

const SHA1 = '1111111111111111111111111111111111111111';
const SHA2 = '2222222222222222222222222222222222222222';
const SAMPLE = 'docs/engineering/agent-pilot-sample.md';
const assert = (condition, message) => { if (!condition) throw new Error(message); };

export function simulatePilot() {
  const events = [{step:'founder_scope',state:'fixture_only',allowed_files:[SAMPLE]}];
  const first = { sha:SHA1, changedFiles:[SAMPLE], text:'# Pilot\\nMissing acceptance marker' };
  events.push({step:'claude_implementation',sha:first.sha,mode:'synthetic_fixture'});
  let initialFailed = false;
  try { verify({changedFiles:first.changedFiles,sampleText:first.text}); }
  catch(e) { initialFailed = e.message.startsWith('ACCEPTANCE_FAILED'); events.push({step:'ci',sha:first.sha,result:e.message}); }
  assert(initialFailed,'Expected first fixture to fail acceptance');
  const review = validateReview({
    reviewed_commit:SHA1,
    recommendation:'recommend_changes',
    required_changes:[{id:'P1',file:SAMPLE,change:'Add the exact acceptance marker',in_scope:true,founder_only:false}]
  }, SHA1);
  assert(review.required_changes.length===1,'Expected one finding');
  events.push({step:'openai_review',sha:SHA1,mode:'synthetic_fixture',finding:'P1'});
  const corrected = {sha:SHA2,changedFiles:[SAMPLE],text:'# Pilot\\nCBC PILOT ACCEPTANCE: PASS'};
  events.push({step:'claude_correction',sha:SHA2,mode:'synthetic_fixture',round:1});
  const outcome = verify({changedFiles:corrected.changedFiles,sampleText:corrected.text});
  events.push({step:'ci',sha:SHA2,result:outcome.status});
  const finalReview = validateReview({reviewed_commit:SHA2,recommendation:'recommend_approve',required_changes:[]},SHA2);
  events.push({step:'openai_review',sha:SHA2,mode:'synthetic_fixture',recommendation:finalReview.recommendation});
  events.push({step:'founder_action_required',reason:'No automated merge or deployment'});
  return {status:'fixture_pass',real_agents_invoked:false,github_actions_run:false,events};
}

if (process.argv[1]?.endsWith('/orchestrate.mjs')) {
  if (process.argv.slice(2).join(' ') !== '--offline-fixture') {
    console.error('DISABLED: only --offline-fixture is supported; no agent/API execution');
    process.exitCode=2;
  } else {
    try { console.log(JSON.stringify(simulatePilot(),null,2)); }
    catch(e) { console.error(e.message);process.exitCode=1; }
  }
}
