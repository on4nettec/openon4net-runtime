import { NotFoundError, ValidationError } from '@o2n/governance';
import type { SkillDefinition } from '@o2n/shared';
import type { Queryable } from '../db.js';

export type SkillProposalStatus = 'pending' | 'approved' | 'rejected';

export interface SkillProposal {
  id: string;
  agentId: string;
  organizationId: string;
  proposedDefinition: SkillDefinition;
  patternMetadata: Record<string, unknown>;
  status: SkillProposalStatus;
  reviewedByUserId: string | null;
  createdAt: string;
}

interface ProposalRow {
  id: string;
  agent_id: string;
  organization_id: string;
  proposed_definition: SkillDefinition;
  pattern_metadata: Record<string, unknown>;
  status: SkillProposalStatus;
  reviewed_by_user_id: string | null;
  created_at: string;
}

function toProposal(row: ProposalRow): SkillProposal {
  return {
    id: row.id,
    agentId: row.agent_id,
    organizationId: row.organization_id,
    proposedDefinition: row.proposed_definition,
    patternMetadata: row.pattern_metadata,
    status: row.status,
    reviewedByUserId: row.reviewed_by_user_id,
    createdAt: row.created_at,
  };
}

/** Review flow for Auto-Skill Detection's output (skill-pattern-detector.ts) — same list/get-with-status-guard/resolve shape as approval-service.ts. */
export class SkillProposalService {
  constructor(private db: Queryable) {}

  async listPending(organizationId: string): Promise<SkillProposal[]> {
    const { rows } = await this.db.query<ProposalRow>(
      `SELECT * FROM skill_proposals WHERE organization_id = $1 AND status = 'pending' ORDER BY created_at`,
      [organizationId],
    );
    return rows.map(toProposal);
  }

  async getPendingById(organizationId: string, id: string): Promise<SkillProposal> {
    const { rows } = await this.db.query<ProposalRow>(
      `SELECT * FROM skill_proposals WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Skill proposal', id);
    if (row.status !== 'pending') {
      throw new ValidationError(`Skill proposal ${id} is already ${row.status}, not pending`);
    }
    return toProposal(row);
  }

  async resolve(organizationId: string, id: string, status: 'approved' | 'rejected', reviewedByUserId: string): Promise<void> {
    await this.db.query(
      `UPDATE skill_proposals SET status = $1, reviewed_by_user_id = $2 WHERE id = $3 AND organization_id = $4`,
      [status, reviewedByUserId, id, organizationId],
    );
  }
}
