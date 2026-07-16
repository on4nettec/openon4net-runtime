import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

export interface PluginGrant {
  id: string;
  agentId: string;
  pluginId: string;
  grantedByUserId: string | null;
  createdAt: string;
}

interface GrantRow {
  id: string;
  agent_id: string;
  plugin_id: string;
  granted_by_user_id: string | null;
  created_at: string;
}

function toGrant(row: GrantRow): PluginGrant {
  return {
    id: row.id,
    agentId: row.agent_id,
    pluginId: row.plugin_id,
    grantedByUserId: row.granted_by_user_id,
    createdAt: row.created_at,
  };
}

/** Connects a Marketplace Plugin to an Agent — same shape/lifecycle as SkillGrantService, for RT-080 (docs/spect/06_MEETINGS/04-plugin-ecosystem-architecture.md). */
export class PluginGrantService {
  constructor(private db: Queryable) {}

  async listForAgent(agentId: string): Promise<PluginGrant[]> {
    const { rows } = await this.db.query<GrantRow>(
      `SELECT * FROM agent_plugin_grants WHERE agent_id = $1 ORDER BY created_at`,
      [agentId],
    );
    return rows.map(toGrant);
  }

  async hasGrant(agentId: string, pluginId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM agent_plugin_grants WHERE agent_id = $1 AND plugin_id = $2`,
      [agentId, pluginId],
    );
    return rows.length > 0;
  }

  async grant(agentId: string, pluginId: string, grantedByUserId: string): Promise<PluginGrant> {
    const { rows } = await this.db.query<GrantRow>(
      `INSERT INTO agent_plugin_grants (agent_id, plugin_id, granted_by_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, plugin_id) DO UPDATE SET granted_by_user_id = EXCLUDED.granted_by_user_id
       RETURNING *`,
      [agentId, pluginId, grantedByUserId],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toGrant(row);
  }

  async revoke(agentId: string, pluginId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM agent_plugin_grants WHERE agent_id = $1 AND plugin_id = $2 RETURNING id`,
      [agentId, pluginId],
    );
    if (!rows[0]) throw new NotFoundError('Plugin grant', `${agentId}/${pluginId}`);
  }
}
