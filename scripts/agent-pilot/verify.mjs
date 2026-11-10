import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ALLOWED = new Set(['docs/engineering/agent-pilot-sample.md']);
export function verify({ changedFiles, sampleText }) {
  if (!Array.isArray(changedFiles) || changedFiles.length !== 1 ||
      changedFiles[0] !== 'docs/engineering/agent-pilot-sample.md') {
    throw new Error('OUT_OF_SCOPE: only the pilot sample document may change');
  }
  if (typeof sampleText !== 'string' || !sampleText.includes('CBC PILOT ACCEPTANCE: PASS')) {
    throw new Error('ACCEPTANCE_FAILED: required acceptance marker absent');
  }
  return { status: 'passed', changedFiles, marker: 'CBC PILOT ACCEPTANCE: PASS' };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const [file] = process.argv.slice(2);
  if (!file) { console.error('Usage: node verify.mjs <pilot-sample-path>'); process.exitCode = 2; }
  else {
    try { console.log(JSON.stringify(verify({changedFiles:['docs/engineering/agent-pilot-sample.md'],sampleText:readFileSync(file,'utf8')}))); }
    catch(e) { console.error(e.message); process.exitCode = 1; }
  }
}
