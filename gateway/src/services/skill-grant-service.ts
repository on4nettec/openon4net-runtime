import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

export interface SkillGrant {
  id: string;
  agentId: string;
  skillId: string;
  grantedByUserId: string | null;
  createdAt: string;
}

interface GrantRow {
  id: string;
  agent_id: string;
  skill_id: string;
  granted_by_user_id: string | null;
  created_at: string;
}

function toGrant(row: GrantRow): SkillGrant {
  return {
    id: row.id,
    agentId: row.agent_id,
    skillId: row.skill_id,
    grantedByUserId: row.granted_by_user_id,
    createdAt: row.created_at,
  };
}

/** Connects a Skill to an Agent (docs/spect/02_ARCHITECTURE/03-skill-engine.md §2.1's "SkillGrant") — auditable, revocable, separate from the Skill artifact itself (skill-service.ts). */
export class SkillGrantService {
  constructor(private db: Queryable) {}

  async listForAgent(agentId: string): Promise<SkillGrant[]> {
    const { rows } = await this.db.query<GrantRow>(
      `SELECT * FROM agent_skill_grants WHERE agent_id = $1 ORDER BY created_at`,
      [agentId],
    );
    return rows.map(toGrant);
  }

  async hasGrant(agentId: string, skillId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM agent_skill_grants WHERE agent_id = $1 AND skill_id = $2`,
      [agentId, skillId],
    );
    return rows.length > 0;
  }

  /**
   * RT-086 — the inverse of listForAgent(): given a skill, find another
   * active agent in the same org that has it granted. Used for automatic
   * delegation when the *calling* agent lacks the grant itself — picks the
   * most-recently-granted match (arbitrary but deterministic tie-break;
   * there's no notion of "best" delegate yet). Only ever queried within
   * organizationId, so this can't leak a grant across tenants.
   */
  async findGrantedAgent(organizationId: string, skillId: string, excludeAgentId: string): Promise<{ agentId: string; agentName: string } | null> {
    const { rows } = await this.db.query<{ agent_id: string; agent_name: string }>(
      `SELECT g.agent_id, a.name AS agent_name
       FROM agent_skill_grants g
       JOIN agents a ON a.id = g.agent_id
       WHERE g.skill_id = $1 AND a.organization_id = $2 AND a.id != $3 AND a.status = 'active'
       ORDER BY g.created_at DESC
       LIMIT 1`,
      [skillId, organizationId, excludeAgentId],
    );
    const row = rows[0];
    return row ? { agentId: row.agent_id, agentName: row.agent_name } : null;
  }

  async grant(agentId: string, skillId: string, grantedByUserId: string): Promise<SkillGrant> {
    const { rows } = await this.db.query<GrantRow>(
      `INSERT INTO agent_skill_grants (agent_id, skill_id, granted_by_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, skill_id) DO UPDATE SET granted_by_user_id = EXCLUDED.granted_by_user_id
       RETURNING *`,
      [agentId, skillId, grantedByUserId],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toGrant(row);
  }

  async revoke(agentId: string, skillId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM agent_skill_grants WHERE agent_id = $1 AND skill_id = $2 RETURNING id`,
      [agentId, skillId],
    );
    if (!rows[0]) throw new NotFoundError('Skill grant', `${agentId}/${skillId}`);
  }
}
