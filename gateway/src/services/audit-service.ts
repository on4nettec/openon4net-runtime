import type { AuditStatus, ApprovalStatus } from '@o2n/shared';
import type { Queryable } from '../db.js';

export interface LogActionInput {
  organizationId: string;
  agentId?: string | null;
  userId?: string | null;
  actionType: string;
  actionData: Record<string, unknown>;
  modelUsed?: string | null;
  costCents?: number | null;
  status?: AuditStatus;
  approvalStatus?: ApprovalStatus;
}

export class AuditService {
  constructor(private db: Queryable) {}

  async logAction(input: LogActionInput): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs
         (organization_id, agent_id, user_id, action_type, action_data, model_used, cost_cents, status, approval_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.organizationId,
        input.agentId ?? null,
        input.userId ?? null,
        input.actionType,
        JSON.stringify(input.actionData),
        input.modelUsed ?? null,
        input.costCents ?? null,
        input.status ?? 'success',
        input.approvalStatus ?? 'auto',
      ],
    );
  }
}
