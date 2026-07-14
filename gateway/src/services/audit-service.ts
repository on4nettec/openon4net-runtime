import { createHash } from 'node:crypto';
import type { AuditLog, AuditStatus, ApprovalStatus } from '@o2n/shared';
import type { Queryable } from '../db.js';

const GENESIS_HASH = '0'.repeat(64);

function computeRowHash(organizationId: string, actionType: string, actionDataText: string, createdAtText: string, prevHash: string): string {
  return createHash('sha256').update(`${organizationId}|${actionType}|${actionDataText}|${createdAtText}|${prevHash}`).digest('hex');
}

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
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface ListAuditLogsOptions {
  limit: number;
  offset: number;
  agentId?: string | undefined;
}

// Export has no client-driven pagination (RT-054) — capped high enough to
// cover any realistic single-org export, low enough to bound one query.
const EXPORT_ROW_CAP = 50_000;

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
  prev_hash: string | null;
  row_hash: string | null;
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
    prevHash: row.prev_hash,
    rowHash: row.row_hash,
  };
}

export class AuditService {
  constructor(private db: Queryable) {}

  /**
   * Best-effort hash chain (RT-055): the SELECT-latest-hash + INSERT below
   * aren't wrapped in an explicit transaction/advisory lock — AuditService
   * only receives a Queryable, which may be the raw pool (see db.ts), and
   * pinning a lock would require plumbing a full Db pool through all ~38
   * call sites. Two genuinely concurrent writes to the SAME org's audit
   * trail could in theory both read the same "latest" row_hash and produce
   * two rows pointing at the same prev_hash — a narrow race, documented
   * rather than solved (not the common case for one org's audit stream).
   */
  async logAction(input: LogActionInput): Promise<void> {
    const { rows: priorRows } = await this.db.query<{ row_hash: string | null }>(
      `SELECT row_hash FROM audit_logs WHERE organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
      [input.organizationId],
    );
    const prevHash = priorRows[0]?.row_hash ?? GENESIS_HASH;

    // action_data::text / created_at::text are read back from what Postgres
    // actually stored (canonical jsonb text form, exact timestamp), not
    // re-derived from the JS input — verifyChain() reads the same columns
    // the same way later, so the two sides can never disagree on formatting.
    const { rows } = await this.db.query<{ id: string; action_data_text: string; created_at_text: string }>(
      `INSERT INTO audit_logs
         (organization_id, agent_id, user_id, action_type, action_data, model_used, cost_cents, status, approval_status, ip_address, user_agent, prev_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING id, action_data::text AS action_data_text, created_at::text AS created_at_text`,
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
        input.ipAddress ?? null,
        input.userAgent ?? null,
        prevHash,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');

    const rowHash = computeRowHash(input.organizationId, input.actionType, row.action_data_text, row.created_at_text, prevHash);
    await this.db.query(`UPDATE audit_logs SET row_hash = $1 WHERE id = $2`, [rowHash, row.id]);
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

  /** Export — no offset/limit knobs, just everything for the org up to EXPORT_ROW_CAP, oldest first (natural order for a downloadable log). */
  async listAll(organizationId: string): Promise<AuditLog[]> {
    const { rows } = await this.db.query<AuditLogRow>(
      `SELECT * FROM audit_logs WHERE organization_id = $1 ORDER BY created_at ASC LIMIT $2`,
      [organizationId, EXPORT_ROW_CAP],
    );
    return rows.map(toAuditLog);
  }

  /**
   * Deletes rows older than retentionDays for one org — opt-in, only called
   * by the scheduler for orgs that actually have an effective retention
   * setting (see audit-retention-scheduler.ts). Returns how many rows were
   * removed.
   *
   * Checkpoints the hash chain first: retention and tamper-evidence would
   * otherwise contradict each other (a purge always making verifyChain()
   * report the chain as "broken" starting from whatever's now the oldest
   * surviving row). The newest row about to be deleted's row_hash becomes
   * the new starting point, stored in organizations.settings.auditChainGenesis.
   */
  async purgeExpired(organizationId: string, retentionDays: number): Promise<number> {
    const { rows: checkpointRows } = await this.db.query<{ row_hash: string | null }>(
      `SELECT row_hash FROM audit_logs
       WHERE organization_id = $1 AND created_at < NOW() - ($2 || ' days')::interval AND row_hash IS NOT NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [organizationId, retentionDays],
    );
    const checkpointHash = checkpointRows[0]?.row_hash;
    if (checkpointHash) {
      await this.db.query(`UPDATE organizations SET settings = settings || $1::jsonb WHERE id = $2`, [
        JSON.stringify({ auditChainGenesis: checkpointHash }),
        organizationId,
      ]);
    }

    const { rowCount } = await this.db.query(
      `DELETE FROM audit_logs WHERE organization_id = $1 AND created_at < NOW() - ($2 || ' days')::interval`,
      [organizationId, retentionDays],
    );
    return rowCount ?? 0;
  }

  /**
   * Walks the org's rows oldest-first, recomputing each hash and checking
   * prev_hash linkage. `genesis` should be organizations.settings.
   * auditChainGenesis if the caller has one (see purgeExpired), else the
   * fixed zero-hash is used. Rows with row_hash IS NULL (written before
   * migration 0020) are skipped — unverifiable, not treated as a break.
   */
  async verifyChain(organizationId: string, genesis: string = GENESIS_HASH): Promise<{ valid: boolean; brokenAtId?: string; checkedCount: number }> {
    const { rows } = await this.db.query<{
      id: string;
      action_type: string;
      action_data_text: string;
      created_at_text: string;
      prev_hash: string | null;
      row_hash: string | null;
    }>(
      `SELECT id, action_type, action_data::text AS action_data_text, created_at::text AS created_at_text, prev_hash, row_hash
       FROM audit_logs WHERE organization_id = $1 ORDER BY created_at ASC, id ASC`,
      [organizationId],
    );

    let expectedPrev = genesis;
    let checkedCount = 0;

    for (const row of rows) {
      if (row.row_hash === null) continue; // legacy, pre-chain row — skip

      if (row.prev_hash !== expectedPrev) {
        return { valid: false, brokenAtId: row.id, checkedCount };
      }
      const recomputed = computeRowHash(organizationId, row.action_type, row.action_data_text, row.created_at_text, expectedPrev);
      if (recomputed !== row.row_hash) {
        return { valid: false, brokenAtId: row.id, checkedCount };
      }
      expectedPrev = row.row_hash;
      checkedCount += 1;
    }

    return { valid: true, checkedCount };
  }
}
