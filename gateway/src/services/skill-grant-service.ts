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
