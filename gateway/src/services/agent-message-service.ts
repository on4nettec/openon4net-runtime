import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

interface AgentMessageRow {
  id: string;
  organization_id: string;
  from_agent_id: string | null;
  to_agent_id: string;
  content: string;
  status: 'pending' | 'delivered' | 'failed';
  created_at: string;
  delivered_at: string | null;
}

export interface AgentMessage {
  id: string;
  organizationId: string;
  fromAgentId: string | null;
  toAgentId: string;
  content: string;
  status: 'pending' | 'delivered' | 'failed';
  createdAt: string;
  deliveredAt: string | null;
}

function toAgentMessage(row: AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    organizationId: row.organization_id,
    fromAgentId: row.from_agent_id,
    toAgentId: row.to_agent_id,
    content: row.content,
    status: row.status,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at,
  };
}

/** Async fire-and-forget agent-to-agent messaging (roadmap item 16) — see migrations/0018_agent_messages.sql. */
export class AgentMessageService {
  constructor(private db: Queryable) {}

  async send(organizationId: string, toAgentId: string, content: string, fromAgentId: string | null = null): Promise<AgentMessage> {
    const { rows } = await this.db.query<AgentMessageRow>(
      `INSERT INTO agent_messages (organization_id, from_agent_id, to_agent_id, content)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [organizationId, fromAgentId, toAgentId, content],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toAgentMessage(row);
  }

  async listForAgent(organizationId: string, agentId: string): Promise<AgentMessage[]> {
    const { rows } = await this.db.query<AgentMessageRow>(
      `SELECT * FROM agent_messages WHERE organization_id = $1 AND to_agent_id = $2 ORDER BY created_at DESC`,
      [organizationId, agentId],
    );
    return rows.map(toAgentMessage);
  }

  /** Pending messages across all orgs — used by the scheduler, not org-scoped since it's a background sweep. */
  async listPending(limit = 50): Promise<AgentMessage[]> {
    const { rows } = await this.db.query<AgentMessageRow>(
      `SELECT * FROM agent_messages WHERE status = 'pending' ORDER BY created_at LIMIT $1`,
      [limit],
    );
    return rows.map(toAgentMessage);
  }

  async markDelivered(id: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE agent_messages SET status = 'delivered', delivered_at = NOW() WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!rows[0]) throw new NotFoundError('Agent message', id);
  }

  async markFailed(id: string): Promise<void> {
    await this.db.query(`UPDATE agent_messages SET status = 'failed' WHERE id = $1`, [id]);
  }
}
