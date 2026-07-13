import type { Workspace, WorkspaceCreateInput, WorkspaceUpdateInput } from '@o2n/shared';
import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

interface WorkspaceRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  status: Workspace['status'];
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    status: row.status,
    settings: row.settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceService {
  constructor(private db: Queryable) {}

  async list(organizationId: string, options: { includeArchived?: boolean } = {}): Promise<Workspace[]> {
    const { rows } = await this.db.query<WorkspaceRow>(
      options.includeArchived
        ? `SELECT * FROM workspaces WHERE organization_id = $1 ORDER BY created_at`
        : `SELECT * FROM workspaces WHERE organization_id = $1 AND status = 'active' ORDER BY created_at`,
      [organizationId],
    );
    return rows.map(toWorkspace);
  }

  async create(organizationId: string, input: WorkspaceCreateInput): Promise<Workspace> {
    const { rows } = await this.db.query<WorkspaceRow>(
      `INSERT INTO workspaces (organization_id, name, description) VALUES ($1, $2, $3) RETURNING *`,
      [organizationId, input.name, input.description ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toWorkspace(row);
  }

  async update(organizationId: string, workspaceId: string, input: WorkspaceUpdateInput): Promise<Workspace> {
    const { rows } = await this.db.query<WorkspaceRow>(
      `UPDATE workspaces
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           settings = COALESCE($3, settings),
           updated_at = NOW()
       WHERE id = $4 AND organization_id = $5
       RETURNING *`,
      [
        input.name ?? null,
        input.description ?? null,
        input.settings ? JSON.stringify(input.settings) : null,
        workspaceId,
        organizationId,
      ],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Workspace', workspaceId);
    return toWorkspace(row);
  }

  /** Soft-delete — see migrations/0016_workspace_status.sql's comment on why a hard DELETE isn't safe here. */
  async archive(organizationId: string, workspaceId: string): Promise<Workspace> {
    const { rows } = await this.db.query<WorkspaceRow>(
      `UPDATE workspaces SET status = 'archived', updated_at = NOW() WHERE id = $1 AND organization_id = $2 RETURNING *`,
      [workspaceId, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Workspace', workspaceId);
    return toWorkspace(row);
  }

  async isActive(organizationId: string, workspaceId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ status: Workspace['status'] }>(
      `SELECT status FROM workspaces WHERE id = $1 AND organization_id = $2`,
      [workspaceId, organizationId],
    );
    return rows[0]?.status === 'active';
  }
}
