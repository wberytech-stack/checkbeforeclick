import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TASK } from './task.mjs';

export function verify({ changedFiles, sampleText }) {
  if (!Array.isArray(changedFiles) || changedFiles.length !== 1 ||
      changedFiles[0] !== TASK.allowedFile) throw new Error('OUT_OF_SCOPE');
  if (typeof sampleText !== 'string' || !sampleText.split(/\r?\n/).some(line=>line.trim()===TASK.acceptance))
    throw new Error('ACCEPTANCE_FAILED: required standalone marker missing');
  return { status:'passed', acceptance:TASK.acceptance };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: node verify.mjs <sample-file>');process.exitCode=2; }
  else try {console.log(JSON.stringify(verify({changedFiles:[TASK.allowedFile],sampleText:readFileSync(file,'utf8')})));}
  catch(e){console.error(e.message);process.exitCode=1;}
}
