import type { Agent, AgentCreateInput, AgentStatus, AgentUpdateInput, KpiDefinition } from '@o2n/shared';
import { NotFoundError, ValidationError } from '@o2n/governance';
import type { Queryable } from '../db.js';

interface AgentRow {
  id: string;
  organization_id: string;
  workspace_id: string;
  name: string;
  role: string;
  status: AgentStatus;
  reports_to: string | null;
  department: string | null;
  monthly_budget_cents: string;
  used_budget_cents: string;
  model_preferences: Agent['modelPreferences'];
  permissions: Record<string, unknown>;
  schedule: Record<string, unknown>;
  kpi_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    name: row.name,
    role: row.role,
    status: row.status,
    reportsTo: row.reports_to,
    department: row.department,
    monthlyBudgetCents: Number(row.monthly_budget_cents),
    usedBudgetCents: Number(row.used_budget_cents),
    modelPreferences: row.model_preferences,
    permissions: row.permissions,
    schedule: row.schedule,
    kpiConfig: row.kpi_config,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentService {
  constructor(private db: Queryable) {}

  async create(organizationId: string, input: AgentCreateInput): Promise<Agent> {
    const { rows } = await this.db.query<AgentRow>(
      `INSERT INTO agents
         (organization_id, workspace_id, name, role, reports_to, department,
          monthly_budget_cents, model_preferences, permissions, schedule, kpi_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        organizationId,
        input.workspaceId,
        input.name,
        input.role,
        input.reportsTo ?? null,
        input.department ?? null,
        input.monthlyBudgetCents,
        JSON.stringify(input.modelPreferences),
        JSON.stringify(input.permissions),
        JSON.stringify(input.schedule),
        JSON.stringify(input.kpiConfig),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toAgent(row);
  }

  async list(organizationId: string): Promise<Agent[]> {
    const { rows } = await this.db.query<AgentRow>(
      `SELECT * FROM agents WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map(toAgent);
  }

  async getById(organizationId: string, agentId: string): Promise<Agent> {
    const { rows } = await this.db.query<AgentRow>(
      `SELECT * FROM agents WHERE id = $1 AND organization_id = $2`,
      [agentId, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Agent', agentId);
    return toAgent(row);
  }

  /**
   * reportsTo must never point back at agentId itself, nor at a descendant
   * of agentId (that would create a cycle in the hierarchy — walk up from
   * the candidate manager; if we reach agentId, reject). Org agent counts
   * are small enough this doesn't need a recursive SQL CTE.
   */
  private async assertNoReportsToCycle(organizationId: string, agentId: string, candidateManagerId: string): Promise<void> {
    if (candidateManagerId === agentId) {
      throw new ValidationError('An agent cannot report to itself');
    }
    let current: string | null = candidateManagerId;
    const seen = new Set<string>();
    while (current) {
      if (current === agentId) {
        throw new ValidationError('That would create a cycle in the reporting hierarchy');
      }
      if (seen.has(current)) break; // pre-existing corrupt cycle unrelated to this change — don't loop forever
      seen.add(current);
      const result: { rows: { reports_to: string | null }[] } = await this.db.query<{ reports_to: string | null }>(
        `SELECT reports_to FROM agents WHERE id = $1 AND organization_id = $2`,
        [current, organizationId],
      );
      current = result.rows[0]?.reports_to ?? null;
    }
  }

  async update(organizationId: string, agentId: string, input: AgentUpdateInput): Promise<Agent> {
    await this.getById(organizationId, agentId); // 404s if missing/wrong org
    if (input.reportsTo) {
      await this.assertNoReportsToCycle(organizationId, agentId, input.reportsTo);
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    const set = (column: string, value: unknown): void => {
      fields.push(`${column} = $${i}`);
      values.push(value);
      i += 1;
    };

    if (input.name !== undefined) set('name', input.name);
    if (input.role !== undefined) set('role', input.role);
    if (input.status !== undefined) set('status', input.status);
    if (input.reportsTo !== undefined) set('reports_to', input.reportsTo);
    if (input.department !== undefined) set('department', input.department);
    if (input.monthlyBudgetCents !== undefined) set('monthly_budget_cents', input.monthlyBudgetCents);
    if (input.modelPreferences !== undefined) set('model_preferences', JSON.stringify(input.modelPreferences));
    if (input.permissions !== undefined) set('permissions', JSON.stringify(input.permissions));
    if (input.schedule !== undefined) set('schedule', JSON.stringify(input.schedule));
    if (input.kpiConfig !== undefined) set('kpi_config', JSON.stringify(input.kpiConfig));
    set('updated_at', new Date().toISOString());

    values.push(agentId, organizationId);
    const { rows } = await this.db.query<AgentRow>(
      `UPDATE agents SET ${fields.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`,
      values,
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Agent', agentId);
    return toAgent(row);
  }

  async setStatus(organizationId: string, agentId: string, status: AgentStatus): Promise<Agent> {
    return this.update(organizationId, agentId, { status });
  }

  async addUsedBudget(organizationId: string, agentId: string, costCents: number): Promise<void> {
    await this.db.query(
      `UPDATE agents SET used_budget_cents = used_budget_cents + $1, updated_at = NOW()
       WHERE id = $2 AND organization_id = $3`,
      [costCents, agentId, organizationId],
    );
  }

  /** Direct reports only (agents whose reports_to = agentId). */
  async listReports(organizationId: string, agentId: string): Promise<Agent[]> {
    const { rows } = await this.db.query<AgentRow>(
      `SELECT * FROM agents WHERE organization_id = $1 AND reports_to = $2 ORDER BY created_at`,
      [organizationId, agentId],
    );
    return rows.map(toAgent);
  }

  /**
   * The transitive subtree under agentId — "team assignment" (roadmap item
   * 18) is this: a manager's team is whoever reports to them, directly or
   * through another manager. Built in application code over list()'s
   * already-small per-org result set rather than a recursive SQL CTE.
   */
  async listTeam(organizationId: string, agentId: string): Promise<Agent[]> {
    const all = await this.list(organizationId);
    const byManager = new Map<string, Agent[]>();
    for (const agent of all) {
      if (!agent.reportsTo) continue;
      const bucket = byManager.get(agent.reportsTo) ?? [];
      bucket.push(agent);
      byManager.set(agent.reportsTo, bucket);
    }

    const team: Agent[] = [];
    const queue = [...(byManager.get(agentId) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      team.push(next);
      queue.push(...(byManager.get(next.id) ?? []));
    }
    return team;
  }

  /** Used by workflow-executor.ts's `agent` step to resolve which agent handles a role. First active match wins. */
  async findByRole(organizationId: string, role: string): Promise<Agent | null> {
    const { rows } = await this.db.query<AgentRow>(
      `SELECT * FROM agents WHERE organization_id = $1 AND role = $2 AND status = 'active' ORDER BY created_at LIMIT 1`,
      [organizationId, role],
    );
    const row = rows[0];
    return row ? toAgent(row) : null;
  }

  /** Full-replace of kpi_config.kpis — admin-set targets + API-driven current values (roadmap item 15; not an auto-computed Outcome Engine, that's Phase 4). */
  async updateKpis(organizationId: string, agentId: string, kpis: KpiDefinition[]): Promise<Agent> {
    const { rows } = await this.db.query<AgentRow>(
      `UPDATE agents SET kpi_config = kpi_config || $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND organization_id = $3
       RETURNING *`,
      [JSON.stringify({ kpis }), agentId, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Agent', agentId);
    return toAgent(row);
  }
}
