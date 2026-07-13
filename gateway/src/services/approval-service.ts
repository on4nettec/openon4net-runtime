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

export interface ApprovalCreateInput {
  agentId?: string | undefined;
  actionData: Record<string, unknown>;
  reason?: string | undefined;
  /** Omitted = never auto-expires; the expiry sweep (services/approval-expiry-scheduler.ts) only touches rows that have one set. */
  expiresAt?: Date | undefined;
}

export class ApprovalService {
  constructor(private db: Queryable) {}

  /** Generic entry point — any subsystem can queue an approval, not just ChatService's cost/policy gate. */
  async create(organizationId: string, input: ApprovalCreateInput): Promise<ApprovalQueueEntry> {
    const { rows } = await this.db.query<ApprovalRow>(
      `INSERT INTO approval_queue (organization_id, agent_id, action_data, reason, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [organizationId, input.agentId ?? null, JSON.stringify(input.actionData), input.reason ?? null, input.expiresAt ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toEntry(row);
  }

  /** Bulk-expires anything still pending past its expires_at — see services/approval-expiry-scheduler.ts. Returns how many rows were touched. */
  async expireStale(): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE approval_queue SET status = 'expired' WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()`,
    );
    return rowCount ?? 0;
  }

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
