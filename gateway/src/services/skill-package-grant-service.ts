import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

export interface SkillPackageGrant {
  id: string;
  agentId: string;
  skillPackageId: string;
  grantedByUserId: string | null;
  createdAt: string;
}

interface GrantRow {
  id: string;
  agent_id: string;
  skill_package_id: string;
  granted_by_user_id: string | null;
  created_at: string;
}

function toGrant(row: GrantRow): SkillPackageGrant {
  return {
    id: row.id,
    agentId: row.agent_id,
    skillPackageId: row.skill_package_id,
    grantedByUserId: row.granted_by_user_id,
    createdAt: row.created_at,
  };
}

/**
 * RT-087 — connects an Agent-Skills-standard package to an Agent, mirroring
 * skill-grant-service.ts's SkillGrantService exactly for the older
 * JSON-steps Skill model. No delegation concept here (unlike RT-086's
 * SkillGrantService.findGrantedAgent()) — a skill package is pure
 * documentation with no side effects, so there's nothing to hand off to
 * another agent; visibility is gated by grant, not execution.
 */
export class SkillPackageGrantService {
  constructor(private db: Queryable) {}

  async listForAgent(agentId: string): Promise<SkillPackageGrant[]> {
    const { rows } = await this.db.query<GrantRow>(
      `SELECT * FROM agent_skill_package_grants WHERE agent_id = $1 ORDER BY created_at`,
      [agentId],
    );
    return rows.map(toGrant);
  }

  async hasGrant(agentId: string, skillPackageId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM agent_skill_package_grants WHERE agent_id = $1 AND skill_package_id = $2`,
      [agentId, skillPackageId],
    );
    return rows.length > 0;
  }

  async grant(agentId: string, skillPackageId: string, grantedByUserId: string): Promise<SkillPackageGrant> {
    const { rows } = await this.db.query<GrantRow>(
      `INSERT INTO agent_skill_package_grants (agent_id, skill_package_id, granted_by_user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, skill_package_id) DO UPDATE SET granted_by_user_id = EXCLUDED.granted_by_user_id
       RETURNING *`,
      [agentId, skillPackageId, grantedByUserId],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toGrant(row);
  }

  async revoke(agentId: string, skillPackageId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM agent_skill_package_grants WHERE agent_id = $1 AND skill_package_id = $2 RETURNING id`,
      [agentId, skillPackageId],
    );
    if (!rows[0]) throw new NotFoundError('Skill package grant', `${agentId}/${skillPackageId}`);
  }
}
