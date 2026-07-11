import { NotFoundError, ValidationError } from '@o2n/governance';
import type { Queryable } from '../db.js';

export type AgentAccessRole = 'owner' | 'member' | 'viewer';

export interface AgentAccessBinding {
  id: string;
  agentId: string;
  userId: string;
  userEmail: string;
  userName: string;
  accessRole: AgentAccessRole;
  grantedByUserId: string | null;
  createdAt: string;
}

interface BindingRow {
  id: string;
  agent_id: string;
  user_id: string;
  user_email: string;
  user_name: string;
  access_role: AgentAccessRole;
  granted_by_user_id: string | null;
  created_at: string;
}

function toBinding(row: BindingRow): AgentAccessBinding {
  return {
    id: row.id,
    agentId: row.agent_id,
    userId: row.user_id,
    userEmail: row.user_email,
    userName: row.user_name,
    accessRole: row.access_role,
    grantedByUserId: row.granted_by_user_id,
    createdAt: row.created_at,
  };
}

/**
 * RT-024 — per-user access to specific agents. admin bypasses this table
 * entirely (see requireAgentAccessible in lib/require-permission.ts) — only
 * non-admin roles are actually gated by these bindings, so admin never
 * needs (and can't be denied) a row here.
 */
export class AgentAccessService {
  constructor(private db: Queryable) {}

  async listForAgent(organizationId: string, agentId: string): Promise<AgentAccessBinding[]> {
    const { rows } = await this.db.query<BindingRow>(
      `SELECT b.id, b.agent_id, b.user_id, u.email AS user_email, u.name AS user_name,
              b.access_role, b.granted_by_user_id, b.created_at
       FROM agent_access_bindings b
       JOIN agents a ON a.id = b.agent_id
       JOIN users u ON u.id = b.user_id
       WHERE b.agent_id = $1 AND a.organization_id = $2
       ORDER BY b.created_at`,
      [agentId, organizationId],
    );
    return rows.map(toBinding);
  }

  /** Agent IDs (within this org) that userId has an explicit binding for — used to filter the agents list for non-admin users. */
  async listAccessibleAgentIds(organizationId: string, userId: string): Promise<Set<string>> {
    const { rows } = await this.db.query<{ agent_id: string }>(
      `SELECT b.agent_id FROM agent_access_bindings b
       JOIN agents a ON a.id = b.agent_id
       WHERE b.user_id = $1 AND a.organization_id = $2`,
      [userId, organizationId],
    );
    return new Set(rows.map((r) => r.agent_id));
  }

  async hasAccess(agentId: string, userId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM agent_access_bindings WHERE agent_id = $1 AND user_id = $2`,
      [agentId, userId],
    );
    return rows.length > 0;
  }

  async grant(
    organizationId: string,
    agentId: string,
    targetUserId: string,
    accessRole: AgentAccessRole,
    grantedByUserId: string,
  ): Promise<AgentAccessBinding> {
    const { rows: userRows } = await this.db.query<{ id: string }>(
      `SELECT id FROM users WHERE id = $1 AND organization_id = $2`,
      [targetUserId, organizationId],
    );
    if (!userRows[0]) throw new NotFoundError('User', targetUserId);

    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO agent_access_bindings (agent_id, user_id, access_role, granted_by_user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, user_id) DO UPDATE SET access_role = EXCLUDED.access_role
       RETURNING id`,
      [agentId, targetUserId, accessRole, grantedByUserId],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Insert did not return a row');

    const [binding] = await this.listForAgent(organizationId, agentId).then((list) =>
      list.filter((b) => b.id === id),
    );
    if (!binding) throw new Error('Grant did not return a row');
    return binding;
  }

  async revoke(organizationId: string, agentId: string, targetUserId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM agent_access_bindings b
       USING agents a
       WHERE b.agent_id = a.id AND a.organization_id = $1
         AND b.agent_id = $2 AND b.user_id = $3
       RETURNING b.id`,
      [organizationId, agentId, targetUserId],
    );
    if (!rows[0]) throw new NotFoundError('Agent access binding', `${agentId}/${targetUserId}`);
  }

  /** Called once, right after INSERT INTO agents — the creator always keeps access to what they made. */
  async grantOwner(agentId: string, userId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_access_bindings (agent_id, user_id, access_role, granted_by_user_id)
       VALUES ($1, $2, 'owner', $2)
       ON CONFLICT (agent_id, user_id) DO NOTHING`,
      [agentId, userId],
    );
  }
}

export function assertValidAccessRole(value: unknown): asserts value is AgentAccessRole {
  if (value !== 'owner' && value !== 'member' && value !== 'viewer') {
    throw new ValidationError('accessRole must be one of: owner, member, viewer');
  }
}
