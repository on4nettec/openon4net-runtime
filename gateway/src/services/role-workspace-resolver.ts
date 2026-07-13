import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

/** Any role name that exists for the org (system or custom, see routes/roles.ts) — 404s if it doesn't. Shared by UserService and InvitationService. */
export async function resolveRoleId(client: Queryable, organizationId: string, roleName: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM roles WHERE organization_id = $1 AND name = $2`,
    [organizationId, roleName],
  );
  const roleId = rows[0]?.id;
  if (!roleId) throw new NotFoundError('Role', roleName);
  return roleId;
}

/** Explicit workspaceId must be active and belong to the org; omitted defaults to the org's first active workspace. */
export async function resolveWorkspaceId(client: Queryable, organizationId: string, workspaceId?: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    workspaceId
      ? `SELECT id FROM workspaces WHERE id = $1 AND organization_id = $2 AND status = 'active'`
      : `SELECT id FROM workspaces WHERE organization_id = $1 AND status = 'active' ORDER BY created_at LIMIT 1`,
    workspaceId ? [workspaceId, organizationId] : [organizationId],
  );
  const id = rows[0]?.id;
  if (!id) {
    throw workspaceId
      ? new NotFoundError('Workspace', workspaceId)
      : new Error(`Organization ${organizationId} has no active workspace`);
  }
  return id;
}
