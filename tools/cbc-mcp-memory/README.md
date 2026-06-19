# CBC MCP Memory

Internal Model Context Protocol server for CheckBeforeClick project delivery coordination.

This tool gives AI assistants such as Claude and ChatGPT a shared project-memory layer for:

- gate status
- action items
- project decisions
- handoff notes
- architecture notes
- risk register
- project snapshots

It is **not** part of the customer-facing CheckBeforeClick SaaS runtime.

## Hard guardrails

Do not use this against `cbc_prod`.

Do not store:

- customer data
- tenant data
- scan inputs
- scan evidence
- suspicious URLs
- API keys
- secrets
- production credentials
- private user data

This MCP server intentionally does **not** expose:

- shell execution
- raw SQL execution
- production database access
- customer scan data
- secret retrieval

## Location

```text
checkbeforeclick/tools/cbc-mcp-memory/
```

## Local setup

From this folder:

```bash
npm install
cp .env.example .env
```

Create a separate PostgreSQL database, for example:

```bash
createdb cbc_project_memory
```

Set `.env`:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/cbc_project_memory
MCP_AGENT_NAME=cbc-mcp-memory
```

Apply migrations against the separate memory database:

```bash
psql "$DATABASE_URL" -f db/001_init_cbc_memory.sql
psql "$DATABASE_URL" -f db/002_seed_current_cbc_state.sql
```

Build:

```bash
npm run build
```

Run locally:

```bash
npm run dev
```

## Claude Desktop example config

Use the absolute path on your machine.

```json
{
  "mcpServers": {
    "cbc-memory": {
      "command": "npm",
      "args": ["run", "dev"],
      "cwd": "C:/Users/GN User/Documents/GitHub/checkbeforeclick/tools/cbc-mcp-memory",
      "env": {
        "DATABASE_URL": "postgres://postgres:postgres@localhost:5432/cbc_project_memory",
        "MCP_AGENT_NAME": "Claude"
      }
    }
  }
}
```

For production-style use later, prefer `npm run build` and `npm start`.

## Exposed tools

### `get_project_snapshot`

Returns current gates, active actions, recent decisions, latest handoffs, and active risks.

### `record_decision`

Append a project decision.

### `add_action_item`

Create a new project action item.

### `list_open_action_items`

List open, in-progress, or blocked action items.

### `update_action_status`

Update an action item status by id.

### `add_handoff_note`

Create a handoff note between ChatGPT, Claude, and/or the user.

### `get_latest_handoff`

Read recent handoff notes.

### `get_gate_status`

Read gate status.

### `update_gate_status`

Create or update a gate status. This does not approve production execution by itself.

### `search_project_memory`

Search internal project memory across decisions, actions, gates, handoffs, architecture notes, and risks.

## Recommended workflow

Before Claude starts implementation:

```text
Call get_project_snapshot.
```

After Claude finishes implementation:

```text
Call add_handoff_note with what changed, evidence, blockers, and next action.
Call update_gate_status if a gate changed.
Call add_action_item for follow-up tasks.
```

Before ChatGPT reviews:

```text
Call get_latest_handoff.
Call get_gate_status for the active gate.
Call search_project_memory when something is unclear.
```

## Current status

MCP-001 is in progress.

Completed:

- package manifest
- TypeScript config
- environment example
- database schema
- initial seed data
- MCP server skeleton
- local gitignore

Next:

- install dependencies
- apply migrations to a separate local PostgreSQL database
- run TypeScript build
- connect Claude Desktop
- verify tools return expected output
