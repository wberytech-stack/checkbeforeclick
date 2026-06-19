import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pool, query, queryOne } from "./db.js";

const agentName = process.env.MCP_AGENT_NAME || "cbc-mcp-memory";

const server = new McpServer({
  name: "cbc-mcp-memory",
  version: "0.1.0",
});

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
};

function jsonResult(value: unknown): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

server.registerTool(
  "get_project_snapshot",
  {
    title: "Get CBC Project Snapshot",
    description:
      "Returns the current CBC MCP project-memory snapshot: gates, open actions, recent decisions, latest handoffs, and open risks. Does not access CBC production data.",
    inputSchema: {},
  },
  async () => {
    const [gates, actions, decisions, handoffs, risks] = await Promise.all([
      query("SELECT gate_name, status, evidence, blockers, next_action, updated_by, updated_at FROM gate_status ORDER BY updated_at DESC LIMIT 20"),
      query("SELECT id, title, owner, status, priority, gate, updated_at FROM action_items WHERE status IN ('open', 'in_progress', 'blocked') ORDER BY priority DESC, updated_at DESC LIMIT 30"),
      query("SELECT title, decision, reason, status, source_agent, related_gate, created_at FROM project_decisions ORDER BY created_at DESC LIMIT 15"),
      query("SELECT from_agent, to_agent, summary, details, related_gate, created_at FROM handoff_notes ORDER BY created_at DESC LIMIT 10"),
      query("SELECT title, risk, impact, mitigation, status, severity, related_gate, updated_at FROM risk_register WHERE status IN ('open', 'monitoring') ORDER BY severity DESC, updated_at DESC LIMIT 20"),
    ]);

    return jsonResult({ gates, open_actions: actions, recent_decisions: decisions, latest_handoffs: handoffs, active_risks: risks });
  }
);

server.registerTool(
  "record_decision",
  {
    title: "Record CBC Project Decision",
    description:
      "Append a CBC project decision. Use this for architecture, security, product, DevOps, or gate decisions. Do not include secrets or customer data.",
    inputSchema: {
      title: z.string().min(3),
      decision: z.string().min(3),
      reason: z.string().optional(),
      status: z.enum(["draft", "accepted", "superseded", "rejected"]).default("accepted"),
      source_agent: z.string().default(agentName),
      related_gate: z.string().optional(),
    },
  },
  async (input) => {
    const row = await queryOne(
      `INSERT INTO project_decisions (title, decision, reason, status, source_agent, related_gate)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, status, related_gate, created_at`,
      [input.title, input.decision, input.reason ?? null, input.status, input.source_agent, input.related_gate ?? null]
    );
    return jsonResult(row);
  }
);

server.registerTool(
  "add_action_item",
  {
    title: "Add CBC Action Item",
    description: "Create a narrowly scoped CBC project action item. Do not include secrets or customer data.",
    inputSchema: {
      title: z.string().min(3),
      details: z.string().optional(),
      owner: z.string().default("unassigned"),
      status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]).default("open"),
      priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
      gate: z.string().optional(),
    },
  },
  async (input) => {
    const row = await queryOne(
      `INSERT INTO action_items (title, details, owner, status, priority, gate)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, title, owner, status, priority, gate, created_at`,
      [input.title, input.details ?? null, input.owner, input.status, input.priority, input.gate ?? null]
    );
    return jsonResult(row);
  }
);

server.registerTool(
  "list_open_action_items",
  {
    title: "List Open CBC Action Items",
    description: "Lists active CBC project action items, optionally filtered by gate.",
    inputSchema: {
      gate: z.string().optional(),
      limit: z.number().int().min(1).max(100).default(30),
    },
  },
  async (input) => {
    const rows = await query(
      `SELECT id, title, details, owner, status, priority, gate, updated_at
       FROM action_items
       WHERE status IN ('open', 'in_progress', 'blocked')
         AND ($1::text IS NULL OR gate = $1)
       ORDER BY priority DESC, updated_at DESC
       LIMIT $2`,
      [input.gate ?? null, input.limit]
    );
    return jsonResult(rows);
  }
);

server.registerTool(
  "update_action_status",
  {
    title: "Update CBC Action Status",
    description: "Updates the status of a CBC action item by id.",
    inputSchema: {
      id: z.string().uuid(),
      status: z.enum(["open", "in_progress", "blocked", "done", "cancelled"]),
      details: z.string().optional(),
    },
  },
  async (input) => {
    const row = await queryOne(
      `UPDATE action_items
       SET status = $2,
           details = COALESCE($3, details)
       WHERE id = $1
       RETURNING id, title, status, priority, gate, updated_at`,
      [input.id, input.status, input.details ?? null]
    );

    if (!row) return textResult(`No action item found for id ${input.id}`);
    return jsonResult(row);
  }
);

server.registerTool(
  "add_handoff_note",
  {
    title: "Add CBC Handoff Note",
    description:
      "Create a handoff note between ChatGPT, Claude, or the user. Use this to stop copy/paste drift. Do not include secrets or customer data.",
    inputSchema: {
      from_agent: z.string().min(2),
      to_agent: z.string().min(2),
      summary: z.string().min(3),
      details: z.string().optional(),
      related_gate: z.string().optional(),
    },
  },
  async (input) => {
    const row = await queryOne(
      `INSERT INTO handoff_notes (from_agent, to_agent, summary, details, related_gate)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, from_agent, to_agent, summary, related_gate, created_at`,
      [input.from_agent, input.to_agent, input.summary, input.details ?? null, input.related_gate ?? null]
    );
    return jsonResult(row);
  }
);

server.registerTool(
  "get_latest_handoff",
  {
    title: "Get Latest CBC Handoff",
    description: "Returns the latest CBC handoff notes, optionally filtered by recipient agent.",
    inputSchema: {
      to_agent: z.string().optional(),
      limit: z.number().int().min(1).max(25).default(5),
    },
  },
  async (input) => {
    const rows = await query(
      `SELECT id, from_agent, to_agent, summary, details, related_gate, created_at
       FROM handoff_notes
       WHERE ($1::text IS NULL OR to_agent = $1)
       ORDER BY created_at DESC
       LIMIT $2`,
      [input.to_agent ?? null, input.limit]
    );
    return jsonResult(rows);
  }
);

server.registerTool(
  "get_gate_status",
  {
    title: "Get CBC Gate Status",
    description: "Returns one gate status by exact gate name, or recent gates if no gate name is provided.",
    inputSchema: {
      gate_name: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async (input) => {
    const rows = await query(
      `SELECT gate_name, status, evidence, blockers, next_action, updated_by, updated_at
       FROM gate_status
       WHERE ($1::text IS NULL OR gate_name = $1)
       ORDER BY updated_at DESC
       LIMIT $2`,
      [input.gate_name ?? null, input.limit]
    );
    return jsonResult(rows);
  }
);

server.registerTool(
  "update_gate_status",
  {
    title: "Update CBC Gate Status",
    description:
      "Upserts a CBC gate status. This does not approve production execution by itself; production gates still require explicit human approval.",
    inputSchema: {
      gate_name: z.string().min(2),
      status: z.enum(["planned", "open", "in_progress", "blocked", "passed", "closed"]),
      evidence: z.string().optional(),
      blockers: z.string().optional(),
      next_action: z.string().optional(),
      updated_by: z.string().default(agentName),
    },
  },
  async (input) => {
    const row = await queryOne(
      `INSERT INTO gate_status (gate_name, status, evidence, blockers, next_action, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (gate_name) DO UPDATE SET
         status = EXCLUDED.status,
         evidence = COALESCE(EXCLUDED.evidence, gate_status.evidence),
         blockers = COALESCE(EXCLUDED.blockers, gate_status.blockers),
         next_action = COALESCE(EXCLUDED.next_action, gate_status.next_action),
         updated_by = EXCLUDED.updated_by
       RETURNING gate_name, status, evidence, blockers, next_action, updated_by, updated_at`,
      [input.gate_name, input.status, input.evidence ?? null, input.blockers ?? null, input.next_action ?? null, input.updated_by]
    );
    return jsonResult(row);
  }
);

server.registerTool(
  "search_project_memory",
  {
    title: "Search CBC Project Memory",
    description:
      "Searches decisions, actions, gates, handoffs, architecture notes, and risks. Does not search CBC production/customer data.",
    inputSchema: {
      query: z.string().min(2),
      limit: z.number().int().min(1).max(50).default(20),
    },
  },
  async (input) => {
    const pattern = `%${input.query}%`;
    const limit = input.limit;

    const [decisions, actions, gates, handoffs, architecture, risks] = await Promise.all([
      query(
        `SELECT 'decision' AS type, id::text, title, decision AS body, related_gate, created_at
         FROM project_decisions
         WHERE title ILIKE $1 OR decision ILIKE $1 OR COALESCE(reason, '') ILIKE $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [pattern, limit]
      ),
      query(
        `SELECT 'action' AS type, id::text, title, COALESCE(details, '') AS body, gate AS related_gate, created_at
         FROM action_items
         WHERE title ILIKE $1 OR COALESCE(details, '') ILIKE $1 OR COALESCE(gate, '') ILIKE $1
         ORDER BY updated_at DESC
         LIMIT $2`,
        [pattern, limit]
      ),
      query(
        `SELECT 'gate' AS type, id::text, gate_name AS title, COALESCE(evidence, '') AS body, gate_name AS related_gate, updated_at AS created_at
         FROM gate_status
         WHERE gate_name ILIKE $1 OR COALESCE(evidence, '') ILIKE $1 OR COALESCE(next_action, '') ILIKE $1 OR COALESCE(blockers, '') ILIKE $1
         ORDER BY updated_at DESC
         LIMIT $2`,
        [pattern, limit]
      ),
      query(
        `SELECT 'handoff' AS type, id::text, summary AS title, COALESCE(details, '') AS body, related_gate, created_at
         FROM handoff_notes
         WHERE summary ILIKE $1 OR COALESCE(details, '') ILIKE $1 OR COALESCE(related_gate, '') ILIKE $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [pattern, limit]
      ),
      query(
        `SELECT 'architecture' AS type, id::text, area AS title, COALESCE(current_state, '') || ' -> ' || COALESCE(target_state, '') AS body, NULL AS related_gate, updated_at AS created_at
         FROM architecture_notes
         WHERE area ILIKE $1 OR COALESCE(current_state, '') ILIKE $1 OR COALESCE(target_state, '') ILIKE $1 OR COALESCE(risks, '') ILIKE $1
         ORDER BY updated_at DESC
         LIMIT $2`,
        [pattern, limit]
      ),
      query(
        `SELECT 'risk' AS type, id::text, title, risk AS body, related_gate, updated_at AS created_at
         FROM risk_register
         WHERE title ILIKE $1 OR risk ILIKE $1 OR COALESCE(mitigation, '') ILIKE $1 OR COALESCE(related_gate, '') ILIKE $1
         ORDER BY updated_at DESC
         LIMIT $2`,
        [pattern, limit]
      ),
    ]);

    return jsonResult({ decisions, actions, gates, handoffs, architecture, risks });
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(async (error) => {
  console.error("CBC MCP Memory server failed:", error);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
