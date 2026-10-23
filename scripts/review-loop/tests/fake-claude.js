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

// ---- probe-claude.ps1 mode: the prompt is the permission self-test ----
if (prompt.includes('permission self-test')) {
  const outside = (prompt.match(/A8 Edit: in the file (.+?), add the line/) || [])[1];
  const tools = has('probe-extra-tool') ? ['Read', 'Grep', 'Glob', 'Edit', 'Bash'] : ['Read', 'Grep', 'Glob', 'Edit'];
  out({ type: 'system', subtype: 'init', cwd: process.cwd(), tools, permissionMode: has('probe-bypass-mode') ? 'bypassPermissions' : 'dontAsk', mcp_servers: [] });
  let n = 0;
  const call = (name, input, ok, content) => { n++; out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't' + n, name, input }] } });
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't' + n, is_error: !ok, content: content || (ok ? 'done' : 'Permission to use ' + name + ' has been denied.') }] } }); };
  const edit = (rel, text, prepend) => { const f = path.join(process.cwd(), ...rel.split('/')); const old = fs.readFileSync(f, 'utf8'); fs.writeFileSync(f, prepend ? text + '\n' + old : old + text + '\n'); };
  if (!has('probe-no-edit')) { edit('scripts/loop-sandbox/redirect.ts', '// probe-edit-ok', true); call('Edit', { file_path: 'scripts/loop-sandbox/redirect.ts' }, true); }
  if (has('probe-edit-readme')) { edit('README.md', 'probe'); call('Edit', { file_path: 'README.md' }, true); } else call('Edit', { file_path: 'README.md' }, false);
  if (has('probe-new-file')) fs.writeFileSync(path.join(process.cwd(), 'scripts', 'loop-sandbox', 'probe-new.ts'), 'x');
  if (has('probe-env-leak')) call('Read', { file_path: '.env.probe' }, true, fs.readFileSync(path.join(process.cwd(), '.env.probe'), 'utf8'));
  else call('Read', { file_path: '.env.probe' }, false);
  if (has('probe-bash-ok')) call('Bash', { command: 'whoami' }, true, 'user');
  call('Read', { file_path: '~/.claude/settings.json' }, has('probe-claude-read-ok'));
  if (has('probe-outside-edit')) { fs.appendFileSync(outside, 'probe\n'); call('Edit', { file_path: outside }, true); } else call('Edit', { file_path: outside }, false);
  call('Read', { file_path: outside }, true, fs.readFileSync(outside, 'utf8'));
  if (has('probe-commit')) execFileSync('git', ['branch', 'probe-sneaky'], { cwd: process.cwd() });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'A1 ok; A2-A8 denied or unavailable; A9 read.' });
  process.exit(0);
}
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
