import type { Queryable } from '../db.js';
import { NotFoundError } from '@o2n/governance';

export type WorkflowRunStatus = 'pending' | 'running' | 'paused' | 'success' | 'failed';

export interface WorkflowRun {
  readonly id: string;
  workflowId: string;
  organizationId: string;
  status: WorkflowRunStatus;
  currentStepId: string | null;
  context: Record<string, unknown>;
  pendingApprovalId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  readonly createdAt: string;
}

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  organization_id: string;
  status: WorkflowRunStatus;
  current_step_id: string | null;
  context: Record<string, unknown>;
  pending_approval_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

function toWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    organizationId: row.organization_id,
    status: row.status,
    currentStepId: row.current_step_id,
    context: row.context,
    pendingApprovalId: row.pending_approval_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
  };
}

/** Run state persistence for workflow-executor.ts — see migrations/0019_workflows.sql. */
export class WorkflowRunService {
  constructor(private db: Queryable) {}

  async create(organizationId: string, workflowId: string): Promise<WorkflowRun> {
    const { rows } = await this.db.query<WorkflowRunRow>(
      `INSERT INTO workflow_runs (workflow_id, organization_id, status, started_at)
       VALUES ($1, $2, 'running', NOW())
       RETURNING *`,
      [workflowId, organizationId],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toWorkflowRun(row);
  }

  async getById(runId: string): Promise<WorkflowRun> {
    const { rows } = await this.db.query<WorkflowRunRow>(`SELECT * FROM workflow_runs WHERE id = $1`, [runId]);
    const row = rows[0];
    if (!row) throw new NotFoundError('Workflow run', runId);
    return toWorkflowRun(row);
  }

  async listForWorkflow(organizationId: string, workflowId: string): Promise<WorkflowRun[]> {
    const { rows } = await this.db.query<WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE organization_id = $1 AND workflow_id = $2 ORDER BY created_at DESC`,
      [organizationId, workflowId],
    );
    return rows.map(toWorkflowRun);
  }

  async updateProgress(runId: string, currentStepId: string | null, context: Record<string, unknown>): Promise<void> {
    await this.db.query(`UPDATE workflow_runs SET current_step_id = $1, context = $2 WHERE id = $3`, [
      currentStepId,
      JSON.stringify(context),
      runId,
    ]);
  }

  async pauseForApproval(runId: string, approvalId: string): Promise<void> {
    await this.db.query(`UPDATE workflow_runs SET status = 'paused', pending_approval_id = $1 WHERE id = $2`, [
      approvalId,
      runId,
    ]);
  }

  async markRunning(runId: string): Promise<void> {
    await this.db.query(`UPDATE workflow_runs SET status = 'running', pending_approval_id = NULL WHERE id = $1`, [runId]);
  }

  async complete(runId: string, status: 'success' | 'failed'): Promise<void> {
    await this.db.query(`UPDATE workflow_runs SET status = $1, completed_at = NOW() WHERE id = $2`, [status, runId]);
  }

  async logStep(runId: string, stepId: string, status: 'running' | 'completed' | 'failed' | 'skipped', result?: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO workflow_run_steps (workflow_run_id, step_id, status, result, completed_at)
       VALUES ($1, $2, $3::varchar, $4, CASE WHEN $3::varchar = 'running' THEN NULL ELSE NOW() END)`,
      [runId, stepId, status, result !== undefined ? JSON.stringify(result) : null],
    );
  }
}
