import type { Workspace, WorkspaceCreateInput } from '@o2n/shared';
import type { Queryable } from '../db.js';

interface WorkspaceRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
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
    settings: row.settings,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WorkspaceService {
  constructor(private db: Queryable) {}

  async list(organizationId: string): Promise<Workspace[]> {
    const { rows } = await this.db.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE organization_id = $1 ORDER BY created_at`,
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
}
