// OFFLINE TEST DOUBLE for headless Claude Code (claude -p). Never calls a model or the network.
// Behaviour is selected by FAKE_CLAUDE (comma list). The prompt arrives on stdin; the argv is recorded to
// FAKE_CLAUDE_ARGV so tests can check the locked-down flags. Output imitates --output-format stream-json.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const args = process.argv.slice(2);
const sc = (process.env.FAKE_CLAUDE || 'fix').split(',');
const has = (s) => sc.includes(s);
if (process.env.FAKE_CLAUDE_ARGV) fs.writeFileSync(process.env.FAKE_CLAUDE_ARGV, JSON.stringify(args));
const prompt = fs.readFileSync(0, 'utf8');
const ids = [...prompt.matchAll(/"id":\s*"(F[0-9]+)"/g)].map((m) => m[1]);
const paths = [...prompt.matchAll(/"path":\s*"([^"]+)"/g)].map((m) => m[1]);
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const append = (rel, text) => fs.appendFileSync(path.join(process.cwd(), ...rel.split('/')), text);

out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools: ['Read', 'Grep', 'Glob', 'Edit'] });
if (has('exit1')) { process.stderr.write('fake: simulated crash\n'); process.exit(1); }
let decisions = ids.map((id, i) => ({ finding_id: id, decision: 'fixed', files: [paths[i]], rationale: 'Validated the empty input before returning.' }));
if (has('fix') || has('edit-outside') || has('new-file') || has('commit') || has('missing-decision') || has('unlisted-change') || has('break-tests')) {
  for (const p of new Set(paths)) append(p, has('break-tests') ? '\n// BREAK\n' : '\n// fixed by fake claude\n');
}
if (has('edit-outside')) append('.agents/claude-handoff.yaml', 'sneaky\n');   // already untracked, so git status stays the same
if (has('edit-tracked')) append('README.md', 'sneaky\n');
if (has('new-file')) fs.writeFileSync(path.join(process.cwd(), 'lib', 'extra.ts'), 'export {}\n');
if (has('commit')) execFileSync('git', ['branch', 'sneaky-ref'], { cwd: process.cwd() });
if (has('reject-all') || has('unlisted-change')) decisions = decisions.map((d) => ({ ...d, decision: 'rejected', files: [], rationale: 'Not a defect.' }));
if (has('founder-only')) decisions = decisions.map((d) => ({ ...d, decision: 'founder_only', files: [], rationale: 'Needs an architecture decision.' }));
if (has('missing-decision')) decisions = [];
// lie-unchanged: claims a fix but edits nothing (decisions stay 'fixed')
out({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } });
let result = JSON.stringify({ schema_version: 1, round: parseInt((prompt.match(/fix round ([0-9]+)/) || [])[1] || '0', 10), decisions });
if (has('malformed')) result = 'I fixed it.';
if (has('fenced')) result = '```json\n' + result + '\n```';
out({ type: 'result', subtype: has('error-result') ? 'error_during_execution' : 'success', is_error: has('error-result'), result });
process.exit(0);
