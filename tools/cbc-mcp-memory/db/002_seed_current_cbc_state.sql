-- ============================================================================
-- CBC MCP Memory / 002 - Seed current project state
--
-- Safe seed data only. No secrets, customer data, tenant data, scan inputs,
-- production credentials, or private evidence.
-- ============================================================================

INSERT INTO project_decisions (title, decision, reason, status, source_agent, related_gate)
VALUES
  (
    'CBC MCP Memory location',
    'Build the internal MCP project memory tool under tools/cbc-mcp-memory inside the checkbeforeclick repository.',
    'The tool supports CBC delivery coordination but is not part of the customer-facing SaaS runtime.',
    'accepted',
    'ChatGPT',
    'MCP-001'
  ),
  (
    'Separate memory database',
    'Use a separate PostgreSQL database for MCP project memory and do not use cbc_prod.',
    'Internal AI coordination data must not mix with customer data, tenant data, scan evidence, or production credentials.',
    'accepted',
    'ChatGPT',
    'MCP-001'
  ),
  (
    'MCP v1 security posture',
    'Expose only narrow project-memory tools. Do not expose shell execution, raw SQL execution, secrets, or production database access.',
    'The tool must reduce copy/paste overhead without creating a broad automation or exfiltration risk.',
    'accepted',
    'ChatGPT',
    'MCP-001'
  )
ON CONFLICT DO NOTHING;

INSERT INTO gate_status (gate_name, status, evidence, blockers, next_action, updated_by)
VALUES
  (
    'MCP-001 Internal Project Memory Foundation',
    'in_progress',
    'Schema and TypeScript MCP server skeleton are being added under tools/cbc-mcp-memory.',
    NULL,
    'Install dependencies, create a separate project-memory database, apply migrations, and connect Claude Desktop to the MCP server.',
    'ChatGPT'
  ),
  (
    'Gate 002 Tenant Isolation Production Apply',
    'open',
    'Prior CBC planning notes show Gate 002 dry-run, production apply plan, guardrails, and runbook committed. Production apply still requires explicit approval.',
    'Awaiting explicit production approval before applying Gate 002 to cbc_prod.',
    'Review and approve production apply only when ready.',
    'ChatGPT'
  )
ON CONFLICT (gate_name) DO UPDATE SET
  status = EXCLUDED.status,
  evidence = EXCLUDED.evidence,
  blockers = EXCLUDED.blockers,
  next_action = EXCLUDED.next_action,
  updated_by = EXCLUDED.updated_by;

INSERT INTO action_items (title, details, owner, status, priority, gate)
VALUES
  (
    'Create separate cbc_project_memory database',
    'Create a local PostgreSQL database for the MCP memory tool. Do not use cbc_prod.',
    'Wbery/Claude',
    'open',
    'high',
    'MCP-001'
  ),
  (
    'Apply MCP memory migrations',
    'Run db/001_init_cbc_memory.sql and db/002_seed_current_cbc_state.sql against the separate project-memory database.',
    'Wbery/Claude',
    'open',
    'high',
    'MCP-001'
  ),
  (
    'Connect Claude Desktop to CBC MCP Memory',
    'Configure Claude Desktop MCP settings to run npm start or npm run dev from tools/cbc-mcp-memory with DATABASE_URL set.',
    'Wbery/Claude',
    'open',
    'medium',
    'MCP-001'
  )
ON CONFLICT DO NOTHING;

INSERT INTO risk_register (title, risk, impact, mitigation, status, severity, related_gate)
VALUES
  (
    'MCP tool overreach',
    'A broad MCP tool could expose shell execution, raw SQL, secrets, or production data.',
    'Could compromise CBC development safety and future enterprise trust.',
    'Keep v1 tools narrow, parameterized, append-oriented, and separate from production systems.',
    'monitoring',
    'high',
    'MCP-001'
  ),
  (
    'Stale AI handoff context',
    'ChatGPT and Claude may act on stale or incomplete project state if project memory is not updated consistently.',
    'Could cause wrong implementation sequence, duplicated work, or unsafe gate assumptions.',
    'Use handoff_notes, gate_status, action_items, and project_decisions as the shared project truth.',
    'monitoring',
    'medium',
    'MCP-001'
  )
ON CONFLICT DO NOTHING;
