import type { ApprovalQueueEntry, ApprovalQueueStatus } from '@o2n/shared';
import { NotFoundError, ValidationError } from '@o2n/governance';
import type { Queryable } from '../db.js';

interface ApprovalRow {
  id: string;
  organization_id: string;
  agent_id: string | null;
  action_data: Record<string, unknown>;
  reason: string | null;
  status: ApprovalQueueStatus;
  assigned_to: string | null;
  expires_at: string | null;
  created_at: string;
}

function toEntry(row: ApprovalRow): ApprovalQueueEntry {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    actionData: row.action_data,
    reason: row.reason,
    status: row.status,
    assignedTo: row.assigned_to,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export class ApprovalService {
  constructor(private db: Queryable) {}

  async listPending(organizationId: string): Promise<ApprovalQueueEntry[]> {
    const { rows } = await this.db.query<ApprovalRow>(
      `SELECT * FROM approval_queue WHERE organization_id = $1 AND status = 'pending' ORDER BY created_at`,
      [organizationId],
    );
    return rows.map(toEntry);
  }

  async getPendingById(organizationId: string, id: string): Promise<ApprovalQueueEntry> {
    const { rows } = await this.db.query<ApprovalRow>(
      `SELECT * FROM approval_queue WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Approval', id);
    if (row.status !== 'pending') {
      throw new ValidationError(`Approval ${id} is already ${row.status}, not pending`);
    }
    return toEntry(row);
  }

  /** Marks resolved and records who resolved it + when, merged into action_data (no dedicated resolver column on this table). */
  async resolve(
    organizationId: string,
    id: string,
    status: 'approved' | 'rejected',
    resolvedByUserId: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE approval_queue
       SET status = $1,
           action_data = action_data || $2::jsonb
       WHERE id = $3 AND organization_id = $4`,
      [status, JSON.stringify({ resolvedBy: resolvedByUserId, resolvedAt: new Date().toISOString() }), id, organizationId],
    );
  }
}
