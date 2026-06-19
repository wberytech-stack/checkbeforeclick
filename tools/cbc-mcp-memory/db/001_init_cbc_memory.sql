-- ============================================================================
-- CBC MCP Memory / 001 - Internal project memory schema
--
-- Purpose:
-- - Store project decisions, action items, gate status, handoff notes, risks,
--   and architecture notes for AI-assisted delivery coordination.
--
-- Guardrails:
-- - This schema is for internal project memory only.
-- - Do NOT apply this to the CBC production application database.
-- - Do NOT store customer data, tenant data, scan evidence, URLs, secrets, or
--   production credentials here.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS project_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  decision text NOT NULL,
  reason text,
  status text NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('draft', 'accepted', 'superseded', 'rejected')),
  source_agent text NOT NULL DEFAULT 'unknown',
  related_gate text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  details text,
  owner text NOT NULL DEFAULT 'unassigned',
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'in_progress', 'blocked', 'done', 'cancelled')),
  priority text NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  gate text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gate_status (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gate_name text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'open', 'in_progress', 'blocked', 'passed', 'closed')),
  evidence text,
  blockers text,
  next_action text,
  updated_by text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS handoff_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent text NOT NULL,
  to_agent text NOT NULL,
  summary text NOT NULL,
  details text,
  related_gate text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS architecture_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  area text NOT NULL,
  current_state text,
  target_state text,
  risks text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'superseded', 'archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS risk_register (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  risk text NOT NULL,
  impact text,
  mitigation text,
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'monitoring', 'mitigated', 'accepted', 'closed')),
  severity text NOT NULL DEFAULT 'medium'
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  related_gate text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS project_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  summary text NOT NULL,
  created_by text NOT NULL DEFAULT 'unknown',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_action_items_updated_at ON action_items;
CREATE TRIGGER trg_action_items_updated_at
BEFORE UPDATE ON action_items
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_gate_status_updated_at ON gate_status;
CREATE TRIGGER trg_gate_status_updated_at
BEFORE UPDATE ON gate_status
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_architecture_notes_updated_at ON architecture_notes;
CREATE TRIGGER trg_architecture_notes_updated_at
BEFORE UPDATE ON architecture_notes
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_risk_register_updated_at ON risk_register;
CREATE TRIGGER trg_risk_register_updated_at
BEFORE UPDATE ON risk_register
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);
CREATE INDEX IF NOT EXISTS idx_action_items_gate ON action_items(gate);
CREATE INDEX IF NOT EXISTS idx_gate_status_name ON gate_status(gate_name);
CREATE INDEX IF NOT EXISTS idx_handoff_notes_created_at ON handoff_notes(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_decisions_created_at ON project_decisions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_risk_register_status ON risk_register(status);
