import type { WorkflowCreateInput, WorkflowDefinition, WorkflowTrigger, WorkflowUpdateInput } from '@o2n/shared';
import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

export type WorkflowStatus = 'draft' | 'active' | 'archived';

export interface Workflow {
  readonly id: string;
  organizationId: string;
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  trigger: WorkflowTrigger;
  createdByUserId: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

interface WorkflowRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  trigger: WorkflowTrigger;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

function toWorkflow(row: WorkflowRow): Workflow {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    definition: row.definition,
    status: row.status,
    trigger: row.trigger,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** CRUD for workflow definitions — mirrors SkillService's shape. Execution lives in workflow-executor.ts. */
export class WorkflowService {
  constructor(private db: Queryable) {}

  async create(organizationId: string, input: WorkflowCreateInput, createdByUserId: string | null): Promise<Workflow> {
    const { rows } = await this.db.query<WorkflowRow>(
      `INSERT INTO workflows (organization_id, name, description, definition, trigger, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        organizationId,
        input.name,
        input.description ?? null,
        JSON.stringify(input.definition),
        JSON.stringify(input.trigger),
        createdByUserId,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toWorkflow(row);
  }

  async list(organizationId: string): Promise<Workflow[]> {
    const { rows } = await this.db.query<WorkflowRow>(
      `SELECT * FROM workflows WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map(toWorkflow);
  }

  async getById(organizationId: string, workflowId: string): Promise<Workflow> {
    const { rows } = await this.db.query<WorkflowRow>(
      `SELECT * FROM workflows WHERE id = $1 AND organization_id = $2`,
      [workflowId, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Workflow', workflowId);
    return toWorkflow(row);
  }

  async update(organizationId: string, workflowId: string, input: WorkflowUpdateInput): Promise<Workflow> {
    await this.getById(organizationId, workflowId); // 404s if missing/wrong org

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    const set = (column: string, value: unknown): void => {
      fields.push(`${column} = $${i}`);
      values.push(value);
      i += 1;
    };

    if (input.name !== undefined) set('name', input.name);
    if (input.description !== undefined) set('description', input.description);
    if (input.definition !== undefined) set('definition', JSON.stringify(input.definition));
    if (input.status !== undefined) set('status', input.status);
    if (input.trigger !== undefined) set('trigger', JSON.stringify(input.trigger));
    set('updated_at', new Date().toISOString());

    values.push(workflowId, organizationId);
    const { rows } = await this.db.query<WorkflowRow>(
      `UPDATE workflows SET ${fields.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`,
      values,
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Workflow', workflowId);
    return toWorkflow(row);
  }
}
