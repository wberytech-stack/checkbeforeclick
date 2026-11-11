// A deliberately narrow, single-task runner. NOT called by the disabled workflow.
// Future execution requires separate founder authorization and credential setup.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { TASK } from './task.mjs';
import { verify } from './verify.mjs';
import { callOpenAIReviewer } from './review.mjs';

const git=(...args)=>execFileSync('git',args,{encoding:'utf8',timeout:20000}).trim();
const run=(command,args,timeout=90000)=>{
  const x=spawnSync(command,args,{encoding:'utf8',timeout,maxBuffer:1024*1024,env:process.env});
  if(x.error||x.status!==0) throw new Error(command+'_FAILED');
  return x.stdout.trim();
};
function assertSafeBranch(){
  if(git('branch','--show-current')!==TASK.branch) throw new Error('WRONG_BRANCH');
  if(git('status','--porcelain')) throw new Error('DIRTY_WORKTREE');
  const base=git('rev-parse','origin/master');
  if(git('merge-base',base,'HEAD')!==base) throw new Error('BASE_MISMATCH');
  return base;
}
function check(base){
  const paths=git('diff','--name-only',base,'HEAD').split('\n').filter(Boolean);
  if(paths.length!==1||paths[0]!==TASK.allowedFile) throw new Error('OUT_OF_SCOPE');
  const sha=git('rev-parse','HEAD');
  let result;
  try {result=verify({changedFiles:paths,sampleText:readFileSync(TASK.allowedFile,'utf8')});}
  catch(e){result={status:'failed',reason:e.message};}
  return {sha,paths,result,diff:git('diff','--no-ext-diff',base,'HEAD','--',TASK.allowedFile)};
}
function claude(prompt){
  // The Claude Code CLI must be installed and authenticated separately.
  // --allowedTools limits file editing to the pilot document; no shell tool.
  run('claude',['-p',prompt,'--permission-mode','dontAsk','--allowedTools','Edit','Write','Read'],120000);
}
export async function executeLivePilot(){
  if(process.env.CBC_AGENT_PILOT_ENABLE!=='founder-approved-one-time') throw new Error('PILOT_DISABLED');
  if(process.env.CBC_AGENT_PILOT_TASK!==TASK.id) throw new Error('UNAPPROVED_TASK');
  if(!process.env.OPENAI_API_KEY||!process.env.CBC_OPENAI_REVIEW_MODEL) throw new Error('MISSING_REVIEWER_AUTH');
  const base=assertSafeBranch();
  if(git('rev-list','--count',base+'..HEAD')!=='0') throw new Error('BRANCH_NOT_FRESH');
  const events=[];
  claude('Edit ONLY '+TASK.allowedFile+'. Produce a short professional CBC pilot note. Do not edit other files, execute commands or use network tools. This first attempt must not include the acceptance marker; the independent reviewer should detect that unmet criterion.');
  if(git('status','--porcelain').split('\n').some(x=>x && !x.endsWith(TASK.allowedFile))) throw new Error('OUT_OF_SCOPE_WORKTREE');
  git('add','--',TASK.allowedFile);git('commit','-m','pilot: initial documentation attempt');
  let snapshot=check(base);events.push({step:'initial',sha:snapshot.sha,acceptance:snapshot.result});
  if(snapshot.result.status!=='failed') throw new Error('EXPECTED_UNMET_CRITERION_NOT_OBSERVED');
  let review=await callOpenAIReviewer({sha:snapshot.sha,diff:snapshot.diff,acceptanceResult:snapshot.result,spec:TASK,apiKey:process.env.OPENAI_API_KEY,model:process.env.CBC_OPENAI_REVIEW_MODEL});
  events.push({step:'review',sha:snapshot.sha,recommendation:review.recommendation,findings:review.required_changes});
  const fixes=review.required_changes.filter(f=>f.in_scope&&!f.founder_only&&f.file===TASK.allowedFile);
  if(review.recommendation!=='recommend_changes'||!fixes.some(f=>/marker|acceptance|criterion/i.test(f.change))) throw new Error('REVIEW_DID_NOT_IDENTIFY_UNMET_CRITERION');
  claude('Correct ONLY '+TASK.allowedFile+'. The reviewer identified this unmet acceptance criterion: '+fixes.map(f=>f.change).join('; ').slice(0,1500)+'. Add exactly one standalone line '+TASK.acceptance+'. Do not modify other files or execute commands.');
  if(git('status','--porcelain').split('\n').some(x=>x && !x.endsWith(TASK.allowedFile))) throw new Error('OUT_OF_SCOPE_WORKTREE');
  git('add','--',TASK.allowedFile);git('commit','-m','pilot: address acceptance review');
  snapshot=check(base);events.push({step:'correction',sha:snapshot.sha,acceptance:snapshot.result});
  if(snapshot.result.status!=='passed') throw new Error('CORRECTION_FAILED');
  review=await callOpenAIReviewer({sha:snapshot.sha,diff:snapshot.diff,acceptanceResult:snapshot.result,spec:TASK,apiKey:process.env.OPENAI_API_KEY,model:process.env.CBC_OPENAI_REVIEW_MODEL});
  events.push({step:'final_review',sha:snapshot.sha,recommendation:review.recommendation});
  if(review.recommendation!=='recommend_approve') throw new Error('FINAL_REVIEW_NOT_READY');
  // No git push or PR mutation: a separate, future approved publishing step is required.
  return {status:'founder_action_required',branch:TASK.branch,base,head:snapshot.sha,events};
}
if(process.argv[1]?.endsWith('/orchestrate.mjs')){
  if(process.argv[2]!=='--live') {console.error('No default execution. --live requires a separate founder-approved activation.');process.exitCode=2;}
  else executeLivePilot().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});
}
