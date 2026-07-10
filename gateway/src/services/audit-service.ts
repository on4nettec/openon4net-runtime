import type { AuditLog, AuditStatus, ApprovalStatus } from '@o2n/shared';
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

export interface ListAuditLogsOptions {
  limit: number;
  offset: number;
  agentId?: string | undefined;
}

interface AuditLogRow {
  id: string;
  organization_id: string;
  agent_id: string | null;
  user_id: string | null;
  action_type: string;
  action_data: Record<string, unknown>;
  model_used: string | null;
  cost_cents: number | null;
  status: AuditStatus;
  approval_status: ApprovalStatus;
  approved_by: string | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

function toAuditLog(row: AuditLogRow): AuditLog {
  return {
    id: row.id,
    organizationId: row.organization_id,
    agentId: row.agent_id,
    userId: row.user_id,
    actionType: row.action_type,
    actionData: row.action_data,
    modelUsed: row.model_used,
    costCents: row.cost_cents,
    status: row.status,
    approvalStatus: row.approval_status,
    approvedBy: row.approved_by,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    createdAt: row.created_at,
  };
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

  /** Org-scoped, newest first (matches idx_audit_logs_org(organization_id, created_at)). */
  async list(organizationId: string, options: ListAuditLogsOptions): Promise<{ logs: AuditLog[]; total: number }> {
    const params: unknown[] = [organizationId];
    let agentFilter = '';
    if (options.agentId) {
      params.push(options.agentId);
      agentFilter = ` AND agent_id = $${params.length}`;
    }

    const { rows: countRows } = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM audit_logs WHERE organization_id = $1${agentFilter}`,
      params,
    );

    params.push(options.limit, options.offset);
    const { rows } = await this.db.query<AuditLogRow>(
      `SELECT * FROM audit_logs WHERE organization_id = $1${agentFilter}
       ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { logs: rows.map(toAuditLog), total: Number(countRows[0]?.count ?? 0) };
  }
}
