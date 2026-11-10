// Founder-reviewed, immutable pilot scope. Not derived from issue/PR comments.
export const TASK = Object.freeze({
  id: 'cbc-doc-pilot-001',
  branch: 'gate-agent-pilot-run-001',
  allowedFile: 'docs/engineering/agent-pilot-sample.md',
  acceptance: 'CBC PILOT ACCEPTANCE: PASS',
  maxCorrections: 1,
  maxClaudeCalls: 2,
  maxOpenAICalls: 2,
  maxInputBytes: 20000,
  maxOutputTokens: 700,
});
