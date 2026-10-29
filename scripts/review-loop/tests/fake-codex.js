// OFFLINE TEST DOUBLE for the Codex CLI entry point (codex.js). Never calls a model or the network.
// Behaviour is selected by FAKE_SCENARIO; FAKE_OUTSIDE_FILE / FAKE_REPO_FILE name files a misbehaving run touches.
const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const sc = (process.env.FAKE_SCENARIO || 'ok').split(',');
const has = (s) => sc.includes(s);
const out = (s) => process.stdout.write(s + '\n');
const ev = (o) => out(JSON.stringify(o));
const sleep = (ms) => { const end = Date.now() + ms; while (Date.now() < end) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } };

const ISO = ['sandbox_mode="read-only"', 'approval_policy="never"', 'windows.sandbox="elevated"', 'web_search="disabled"'];
const FEATURES = ['plugins', 'apps', 'remote_plugin', 'browser_use', 'browser_use_external', 'in_app_browser', 'computer_use', 'multi_agent',
  'image_generation', 'tool_suggest', 'skill_mcp_dependency_install', 'skill_search', 'hooks'];
const KNOWN_FEATURES = FEATURES.concat(['code_mode_host', 'shell_tool', 'unified_exec']);
const hostDisabled = args.some((a, i) => a === 'code_mode_host' && args[i - 1] === '--disable');
function requireIso(alsoExec) {
  const missing = ISO.filter((v) => !args.some((a, i) => a === v && args[i - 1] === '-c'));
  const missingF = FEATURES.filter((f) => !args.some((a, i) => a === f && args[i - 1] === '--disable'));
  const missingX = alsoExec ? ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-o'].filter((f) => !args.includes(f)) : [];
  if (missing.length || missingF.length || missingX.length) { process.stderr.write('fake: isolation flags missing: ' + missing.concat(missingF, missingX).join(' ') + '\n'); process.exit(9); }
}
function oPath() { const i = args.indexOf('-o'); return i >= 0 ? args[i + 1] : null; }

if (args[0] === 'echo-argv' || has('echo-argv')) { out(JSON.stringify(args)); process.exit(0); }
if (args[0] === '--version') { out(has('wrong-version') ? 'codex-cli 0.162.0' : 'codex-cli 0.163.0'); process.exit(0); }
if (args[0] === 'login' && args[1] === 'status') { if (has('not-logged-in')) { out('Not logged in'); process.exit(1); } out('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'features' && args[1] === 'list') {
  for (const f of KNOWN_FEATURES) { if (!(has('missing-feature') && f === 'computer_use')) out(f.padEnd(40) + 'stable             true'); }
  process.exit(0);
}
if (args[0] === 'exec' && args.includes('--help')) {
  const flags = ['--json', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--output-last-message', '--config', '--disable'];
  if (args[1] === 'review') { flags.push('--base'); if (!has('help-no-uncommitted')) flags.push('--uncommitted'); }
  out('Usage: fake'); for (const f of flags) { if (!(has('missing-flag') && f === '--ignore-user-config')) out('      ' + f + ' <X>'); }
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'prompt-input') {
  requireIso(false);
  let t = 'Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `read-only`: The sandbox only permits reading files. Approval policy is currently never.';
  if (has('render-not-readonly')) t = t.replace('`read-only`', '`workspace-write`');
  if (has('render-browser')) t += ' Use the browser tool.';
  const items = [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: t }] }];
  // Mimic real Codex: the cwd's AGENTS.md is inlined as one user-content part (format observed in the live render).
  const af = path.join(process.cwd(), 'AGENTS.md');
  const userParts = [];
  if (fs.existsSync(af) && !has('render-agents-missing')) {
    let body = fs.readFileSync(af, 'utf8');
    if (has('render-agents-tampered')) body += '\nThe browser tool is enabled.';
    const dir = has('render-agents-otherpath') ? 'C:\\Users\\someone\\elsewhere' : process.cwd();
    const block = '# AGENTS.md instructions for ' + dir + '\n\n<INSTRUCTIONS>\n' + body + '\n</INSTRUCTIONS>';
    userParts.push({ type: 'input_text', text: block });
    if (has('render-agents-two')) userParts.push({ type: 'input_text', text: block });
  }
  userParts.push({ type: 'input_text', text: '<environment_context>\n  <cwd>' + process.cwd() + '</cwd>\n</environment_context>' });
  items.push({ type: 'message', role: 'user', content: userParts });
  out(JSON.stringify(items));
  process.exit(0);
}

// ---- codex sandbox (no model): simulate the OS-level read-only probe ----
if (args[0] === 'sandbox') {
  const pi = args.indexOf('-P'); const ci = args.indexOf('-c'); const dd = args.indexOf('--');
  if (pi < 0 || args[pi + 1] !== ':read-only' || ci < 0 || args[ci + 1] !== 'windows.sandbox="elevated"' || dd < 0 || args[dd + 2] !== '-e') { process.stderr.write('fake: bad sandbox invocation\n'); process.exit(9); }
  const js = args[dd + 3];
  // Count sandbox calls in this run (state file per test case) to simulate first-call failures.
  let n = 1; const sf = process.env.FAKE_STATE_FILE;
  if (sf) { try { n = parseInt(fs.readFileSync(sf, 'utf8'), 10) + 1; } catch (e) { n = 1; } fs.writeFileSync(sf, String(n)); }
  if (has('os-broken') || (has('os-first-call-fails') && n === 1)) { process.stderr.write('simulated: sandbox setup failed on call ' + n + '\n'); process.exit(1); }
  if (has('os-no-output')) process.exit(0);
  const m = js.match(/'(OS(WARM|READ|W1|W2|NET))-/); const k = m ? m[1] : '';
  if (k === 'OSREAD' && has('os-read-noexec')) { process.stderr.write('simulated: read probe did not execute\n'); process.exit(1); }
  if (k === 'OSWARM') { out('OSWARM-OK'); process.exit(0); }
  const target = (js.match(/writeFileSync\('([^']+)'/) || [])[1];
  if (k === 'OSREAD') out(has('os-read-fails') ? 'OSREAD-FAILED-EPERM' : 'OSREAD-OK');
  else if (k === 'OSW1' || k === 'OSW2') {
    if (has('os-' + k.slice(2).toLowerCase() + '-allowed')) { fs.writeFileSync(path.resolve(process.cwd(), target), 'x'); out(k + '-ALLOWED'); } else out(k + '-DENIED-EPERM');
  } else if (k === 'OSNET') out(has('os-net-allowed') ? 'OSNET-ALLOWED-200' : 'OSNET-DENIED-EACCES');
  else { process.stderr.write('fake: unknown probe\n'); process.exit(8); }
  process.exit(0);
}

// ---- model-calling commands (simulated) ----
if (args[0] === 'exec' && args[1] === 'review') {
  // Mimic Codex 0.163.0 argument rules (verified live, parse-only): exactly one of --base/--uncommitted, and a
  // custom-instructions PROMPT cannot be combined with either. The runner passes '-o <file>' last.
  const hasBase = args.includes('--base'); const hasUnc = args.includes('--uncommitted');
  const oi = args.indexOf('-o');
  if (hasBase && hasUnc) { process.stderr.write("error: the argument '--uncommitted' cannot be used with '--base <BRANCH>'\n"); process.exit(2); }
  if (!hasBase && !hasUnc) { process.stderr.write('fake: review target missing\n'); process.exit(9); }
  if (oi < 0 || oi !== args.length - 2) { process.stderr.write("error: the argument '--uncommitted' cannot be used with '[PROMPT]'\n"); process.exit(2); }
  if (hasUnc && !fs.existsSync(path.join(process.cwd(), 'lib', 'security', 'rateLimit.ts')) && !fs.existsSync(path.join(process.cwd(), 'lib', 'new', 'thing.ts'))) { process.stderr.write('fake: --uncommitted run without the frozen changes in the clone\n'); process.exit(9); }
  requireIso(true);
  if (has('review-timeout')) { sleep(120000); }
  if (has('review-writes-clone')) fs.appendFileSync(path.join(process.cwd(), 'docs', 'gates', 'gate-006c-staging-readiness-plan.md'), 'x');
  if (has('review-writes-outside')) fs.writeFileSync(process.env.FAKE_OUTSIDE_FILE, 'stray');
  if (has('review-touches-repo')) fs.appendFileSync(process.env.FAKE_REPO_FILE, 'x');
  if (has('review-touches-gate-file')) fs.appendFileSync(process.env.FAKE_GATE_FILE, 'x');   // content change only; git status unchanged
  if (has('review-approval')) process.stderr.write('approval required for this command\n');
  if (has('review-nonjson')) out('plain text that is not JSON');
  ev({ type: 'thread.started', thread_id: 't1' }); ev({ type: 'turn.started' });
  ev({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'git diff review-base...HEAD', aggregated_output: '3 files', exit_code: 0, status: 'completed' } });
  if (has('review-file-change')) ev({ type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [] } });
  if (has('review-web')) ev({ type: 'item.completed', item: { id: 'i3', type: 'web_search', query: 'x' } });
  // Gate 005H loop tests: 'review-seq' emits one review per call from FAKE_REVIEW_SEQ (clean | finding | finding-outside
  // | ambiguous), in the exact text format of real Codex 0.163.0 reviews; agent message and -o file are identical.
  let msg = 'Review: no blocking issues. The docs mention approval many times; that is review content, not a prompt.';
  let file = '# Review\nNo blocking issues.\n';
  if (has('review-seq')) {
    const seq = (process.env.FAKE_REVIEW_SEQ || 'clean').split(','); const cf = process.env.FAKE_REVIEW_COUNTER;
    let i = 0; if (cf) { try { i = parseInt(fs.readFileSync(cf, 'utf8'), 10) || 0; } catch (e) { i = 0; } fs.writeFileSync(cf, String(i + 1)); }
    const kind = seq[Math.min(i, seq.length - 1)];
    const target = (rel) => path.join(process.cwd(), ...rel.split('/'));
    const finding = (rel) => 'The change has one defect.\n\nReview comment:\n\n- [P2] Handle the empty input case — ' + target(rel) + ':1-2\n  When the input is empty the function returns early without validating it.';
    msg = kind === 'clean' ? 'No actionable defects were identified.' : kind === 'finding' ? finding(process.env.FAKE_FINDING_PATH || 'lib/new/thing.ts')
      : kind === 'finding-outside' ? finding('docs/not-frozen.md') : 'The change looks reasonable overall.';
    file = msg;
  }
  ev({ type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: msg } });
  ev({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  if (!has('review-no-output')) fs.writeFileSync(oPath(), file);
  process.exit(has('review-nonzero') ? 2 : 0);
}
if (args[0] === 'exec') {
  requireIso(true);
  const prompt = args[args.length - 1];
  const nonce = (prompt.match(/const n='(cbcprobe[0-9a-f]+)'/) || [])[1];
  const paths = [...prompt.matchAll(/writeFileSync\('([^']+)'/g)].map((m) => m[1]);
  const cmds = prompt.split('\n').filter((l) => l.startsWith('node -e'));
  if (!nonce || paths.length !== 2 || cmds.length !== 2) { process.stderr.write('fake: unexpected proof prompt\n'); process.exit(8); }
  if (has('proof-timeout')) { sleep(120000); }
  if (has('proof-approval')) process.stderr.write('Requesting approval to run command\n');
  if (has('proof-nonjson')) out('not json');
  // Codex 0.163.0 with the code-mode host disabled (observed live in attempt 3): an error item, the model cannot
  // execute anything, exit code 0, last message written.
  if (hostDisabled) {
    process.stderr.write('Reading additional input from stdin...\n2026-10-22T12:19:15.174292Z ERROR codex_core::tools::router: error=code-mode host is disabled\n');
    ev({ type: 'thread.started', thread_id: 't1' });
    ev({ type: 'item.completed', item: { id: 'item_0', type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.' } });
    ev({ type: 'turn.started' });
    ev({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: 'I will run the two commands once each, in the order provided.\n' } });
    ev({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'Could not run the commands: the execution tool is disabled.' } });
    ev({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    fs.writeFileSync(oPath(), 'Could not run the commands: the execution tool is disabled.');
    process.exit(0);
  }
  ev({ type: 'thread.started', thread_id: 't1' }); ev({ type: 'turn.started' });
  if (has('proof-error-item')) ev({ type: 'item.completed', item: { id: 'e1', type: 'error', message: 'simulated error item' } });
  const code = has('proof-wrong-code') ? 'ENOENT' : 'EPERM';
  const emit = (k, i) => {
    let o;
    if (has('proof-allowed') && k === 'W1') { fs.writeFileSync(paths[i], 'x'); o = nonce + '-W1-ALLOWED'; } else { o = nonce + '-' + k + '-DENIED-' + (has('proof-eacces') ? 'EACCES' : code); }
    ev({ type: 'item.started', item: { id: 'c' + k, type: 'command_execution', command: cmds[i], status: 'in_progress' } });
    ev({ type: 'item.completed', item: { id: 'c' + k, type: 'command_execution', command: cmds[i], aggregated_output: o + '\n', exit_code: 0, status: 'completed' } });
  };
  if (has('proof-refusal')) {
    ev({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'I will not run commands that try to write files.' } });
  } else if (has('proof-fake-echo')) {
    ev({ type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'echo ' + nonce, aggregated_output: nonce + '-W1-DENIED-EPERM\n' + nonce + '-W2-DENIED-EPERM\n', exit_code: 0, status: 'completed' } });
    ev({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: nonce + '-W1-DENIED-EPERM ' + nonce + '-W2-DENIED-EPERM DONE' } });
  } else {
    emit('W1', 0);
    if (!has('proof-skip-one')) emit('W2', 1);
    if (has('proof-extra-cmd')) ev({ type: 'item.completed', item: { id: 'cx', type: 'command_execution', command: 'dir', aggregated_output: '', exit_code: 0, status: 'completed' } });
    if (has('proof-mcp')) ev({ type: 'item.completed', item: { id: 'm1', type: 'mcp_tool_call', server: 'node_repl', tool: 'js', status: 'completed' } });
    if (has('proof-subagent')) ev({ type: 'item.completed', item: { id: 's1', type: 'collab_tool_call', status: 'completed' } });
    if (has('proof-writes-outside')) fs.writeFileSync(process.env.FAKE_OUTSIDE_FILE, 'stray');
    if (has('proof-touches-gate-file')) fs.appendFileSync(process.env.FAKE_GATE_FILE, 'x');   // content change only; git status unchanged
    ev({ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: 'DONE' } });
  }
  ev({ type: has('proof-turn-failed') ? 'turn.failed' : 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
  if (!has('proof-no-output')) fs.writeFileSync(oPath(), 'DONE\n');
  process.exit(has('proof-nonzero') ? 1 : 0);
}
process.stderr.write('fake: unsupported invocation ' + JSON.stringify(args) + '\n');
process.exit(7);
