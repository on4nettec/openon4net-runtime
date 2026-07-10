import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';

export interface RoleSummary {
  id: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

/** DB-backed RBAC (migrations/0007_rbac.sql) — resolves a user's actual granted permissions instead of a hardcoded role->permission map. */
export class PermissionService {
  constructor(private db: Queryable) {}

  async getPermissions(userId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ permission: string }>(
      `SELECT DISTINCT rp.permission
       FROM user_role_bindings urb
       JOIN role_permissions rp ON rp.role_id = urb.role_id
       WHERE urb.user_id = $1`,
      [userId],
    );
    return rows.map((r) => r.permission);
  }

  async listRoles(organizationId: string): Promise<RoleSummary[]> {
    const { rows } = await this.db.query<{
      id: string;
      name: string;
      is_system: boolean;
      permission: string | null;
    }>(
      `SELECT r.id, r.name, r.is_system, rp.permission
       FROM roles r
       LEFT JOIN role_permissions rp ON rp.role_id = r.id
       WHERE r.organization_id = $1
       ORDER BY r.name, rp.permission`,
      [organizationId],
    );
    const byId = new Map<string, RoleSummary>();
    for (const row of rows) {
      const existing = byId.get(row.id);
      if (existing) {
        if (row.permission) existing.permissions.push(row.permission);
        continue;
      }
      byId.set(row.id, {
        id: row.id,
        name: row.name,
        isSystem: row.is_system,
        permissions: row.permission ? [row.permission] : [],
      });
    }
    return [...byId.values()];
  }

  /** Replaces a role's entire permission set. Organization-scoped so a role id can't be targeted cross-tenant. */
  async setRolePermissions(organizationId: string, roleId: string, permissions: string[]): Promise<RoleSummary> {
    const { rows: roleRows } = await this.db.query<{ id: string; name: string; is_system: boolean }>(
      `SELECT id, name, is_system FROM roles WHERE id = $1 AND organization_id = $2`,
      [roleId, organizationId],
    );
    const role = roleRows[0];
    if (!role) throw new NotFoundError('Role', roleId);

    await this.db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [roleId]);
    for (const permission of permissions) {
      await this.db.query(`INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`, [
        roleId,
        permission,
      ]);
    }
    return { id: role.id, name: role.name, isSystem: role.is_system, permissions };
  }
}
