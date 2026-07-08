import type { Agent, AgentCreateInput, AgentStatus, AgentUpdateInput } from '@o2n/shared';
import { NotFoundError } from '@o2n/governance';
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

  async update(organizationId: string, agentId: string, input: AgentUpdateInput): Promise<Agent> {
    await this.getById(organizationId, agentId); // 404s if missing/wrong org

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
}
