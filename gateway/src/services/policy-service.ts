import type { PolicyCondition } from '@o2n/shared';
import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

export interface PolicySummary {
  id: string;
  name: string;
  condition: PolicyCondition;
  isActive: boolean;
  createdAt: string;
}

export interface PolicyEvalContext {
  estimatedCostCents: number;
  /** Defaults to now — parameterized for tests. */
  now?: Date;
  /** RT-056 — set by callers outside chat (e.g. routes/tools.ts) to let `action_type_in` conditions match. Omitted entirely by chat-service.ts, so those conditions simply never match a chat request. */
  actionType?: string;
}

export interface PolicyEvalResult {
  requiresApproval: boolean;
  matchedPolicyNames: string[];
}

interface PolicyRow {
  id: string;
  name: string;
  definition: { condition: PolicyCondition };
  is_active: boolean;
  created_at: string;
}

function toSummary(row: PolicyRow): PolicySummary {
  return {
    id: row.id,
    name: row.name,
    condition: row.definition.condition,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

function matches(condition: PolicyCondition, ctx: PolicyEvalContext): boolean {
  const now = ctx.now ?? new Date();
  switch (condition.type) {
    case 'cost_gt_cents':
      return ctx.estimatedCostCents > condition.value;
    case 'outside_hours': {
      const hour = now.getUTCHours();
      // Window can wrap midnight (e.g. startHour=22, endHour=6 means "9pm-6am is the allowed window").
      const inWindow =
        condition.startHour <= condition.endHour
          ? hour >= condition.startHour && hour < condition.endHour
          : hour >= condition.startHour || hour < condition.endHour;
      return !inWindow;
    }
    case 'action_type_in':
      return ctx.actionType !== undefined && condition.actionTypes.includes(ctx.actionType);
    default: {
      const exhaustive: never = condition;
      throw new Error(`Unknown policy condition type: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * MVP ABAC (RT-008, docs/spect/02_ARCHITECTURE/10-rbac-and-policy.md §6) —
 * only a `requires_approval` action, evaluated additively alongside the
 * existing env-wide APPROVAL_THRESHOLD_CENTS check (see chat-service.ts):
 * either one triggering is enough to require approval, neither replaces
 * the other.
 */
export class PolicyService {
  constructor(private db: Queryable) {}

  async list(organizationId: string): Promise<PolicySummary[]> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT id, name, definition, is_active, created_at FROM policies
       WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map(toSummary);
  }

  async create(organizationId: string, name: string, condition: PolicyCondition): Promise<PolicySummary> {
    const { rows } = await this.db.query<PolicyRow>(
      `INSERT INTO policies (organization_id, name, definition)
       VALUES ($1, $2, $3)
       RETURNING id, name, definition, is_active, created_at`,
      [organizationId, name, JSON.stringify({ condition })],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toSummary(row);
  }

  async setActive(organizationId: string, policyId: string, isActive: boolean): Promise<PolicySummary> {
    const { rows } = await this.db.query<PolicyRow>(
      `UPDATE policies SET is_active = $1 WHERE id = $2 AND organization_id = $3
       RETURNING id, name, definition, is_active, created_at`,
      [isActive, policyId, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Policy', policyId);
    return toSummary(row);
  }

  async delete(organizationId: string, policyId: string): Promise<void> {
    const { rowCount } = await this.db.query(`DELETE FROM policies WHERE id = $1 AND organization_id = $2`, [
      policyId,
      organizationId,
    ]);
    if (!rowCount) throw new NotFoundError('Policy', policyId);
  }

  async evaluate(organizationId: string, ctx: PolicyEvalContext): Promise<PolicyEvalResult> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT id, name, definition, is_active, created_at FROM policies
       WHERE organization_id = $1 AND is_active = true`,
      [organizationId],
    );
    const matchedPolicyNames = rows.filter((row) => matches(row.definition.condition, ctx)).map((row) => row.name);
    return { requiresApproval: matchedPolicyNames.length > 0, matchedPolicyNames };
  }
}
