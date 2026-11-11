// Offline tests for the REAL acceptance checker and review validator; no fake model output.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { verify } from './verify.mjs';
import { TASK } from './task.mjs';
const original=readFileSync(TASK.allowedFile,'utf8');
assert.throws(()=>verify({changedFiles:[TASK.allowedFile],sampleText:original}),/ACCEPTANCE_FAILED/);
const corrected=original+'\n'+TASK.acceptance+'\n';
assert.equal(verify({changedFiles:[TASK.allowedFile],sampleText:corrected}).status,'passed');
assert.throws(()=>verify({changedFiles:['app/page.tsx'],sampleText:corrected}),/OUT_OF_SCOPE/);
console.log('PASS: actual checked-in document fails acceptance');
console.log('PASS: corrected document passes acceptance');
console.log('PASS: out-of-scope file rejected');
console.log('NOTE: no Claude/OpenAI calls made; this is an offline test, not an agent demonstration');
