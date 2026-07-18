import type { Queryable } from '../db.js';

export interface WorkspaceFile {
  readonly id: string;
  workspaceId: string;
  filename: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
  uploadedByUserId: string | null;
  readonly createdAt: string;
}

interface WorkspaceFileRow {
  id: string;
  workspace_id: string;
  filename: string;
  storage_key: string;
  content_type: string;
  size_bytes: string;
  uploaded_by_user_id: string | null;
  created_at: string;
}

function toWorkspaceFile(row: WorkspaceFileRow): WorkspaceFile {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    filename: row.filename,
    storageKey: row.storage_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: row.created_at,
  };
}

/**
 * RT-025 — metadata for files attached to an Agent's dedicated workspace
 * (RT-023's 1:1 workspace-per-agent). The actual bytes live in object
 * storage (lib/object-storage.ts); `url` is intentionally NOT stored here —
 * a presigned URL expires, so it's generated fresh on each read
 * (routes/agent-files.ts), not cached in this table.
 */
export class WorkspaceFileService {
  constructor(private db: Queryable) {}

  async create(input: {
    workspaceId: string;
    organizationId: string;
    filename: string;
    storageKey: string;
    contentType: string;
    sizeBytes: number;
    uploadedByUserId: string | null;
  }): Promise<WorkspaceFile> {
    const { rows } = await this.db.query<WorkspaceFileRow>(
      `INSERT INTO workspace_files (workspace_id, organization_id, filename, storage_key, content_type, size_bytes, uploaded_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, workspace_id, filename, storage_key, content_type, size_bytes, uploaded_by_user_id, created_at`,
      [
        input.workspaceId,
        input.organizationId,
        input.filename,
        input.storageKey,
        input.contentType,
        input.sizeBytes,
        input.uploadedByUserId,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toWorkspaceFile(row);
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceFile[]> {
    const { rows } = await this.db.query<WorkspaceFileRow>(
      `SELECT id, workspace_id, filename, storage_key, content_type, size_bytes, uploaded_by_user_id, created_at
       FROM workspace_files WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [workspaceId],
    );
    return rows.map(toWorkspaceFile);
  }

  /** Org-scoped by id, not just workspace — a file id must never resolve across organizations even by guessing. */
  async getById(organizationId: string, fileId: string): Promise<WorkspaceFile | null> {
    const { rows } = await this.db.query<WorkspaceFileRow>(
      `SELECT id, workspace_id, filename, storage_key, content_type, size_bytes, uploaded_by_user_id, created_at
       FROM workspace_files WHERE id = $1 AND organization_id = $2`,
      [fileId, organizationId],
    );
    const row = rows[0];
    return row ? toWorkspaceFile(row) : null;
  }

  async delete(organizationId: string, fileId: string): Promise<WorkspaceFile | null> {
    const { rows } = await this.db.query<WorkspaceFileRow>(
      `DELETE FROM workspace_files WHERE id = $1 AND organization_id = $2
       RETURNING id, workspace_id, filename, storage_key, content_type, size_bytes, uploaded_by_user_id, created_at`,
      [fileId, organizationId],
    );
    const row = rows[0];
    return row ? toWorkspaceFile(row) : null;
  }
}
