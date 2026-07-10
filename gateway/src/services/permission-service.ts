import { NotFoundError, ValidationError } from '@o2n/governance';
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

  /** Custom roles only (is_system=false) — starts with zero permissions, editable afterward via setRolePermissions. */
  async createRole(organizationId: string, name: string): Promise<RoleSummary> {
    const { rows: existing } = await this.db.query<{ id: string }>(
      `SELECT id FROM roles WHERE organization_id = $1 AND name = $2`,
      [organizationId, name],
    );
    if (existing[0]) throw new ValidationError(`A role named "${name}" already exists in this organization`);

    const { rows } = await this.db.query<{ id: string; name: string; is_system: boolean }>(
      `INSERT INTO roles (organization_id, name, is_system) VALUES ($1, $2, false) RETURNING id, name, is_system`,
      [organizationId, name],
    );
    const role = rows[0];
    if (!role) throw new Error('Insert did not return a row');
    return { id: role.id, name: role.name, isSystem: role.is_system, permissions: [] };
  }

  /**
   * Blocks deleting a system role (the 4 seeded ones) and blocks deleting a
   * role that still has users bound to it — user_role_bindings.role_id has
   * ON DELETE CASCADE, so an unblocked delete would silently strip those
   * users of every permission instead of erroring loudly. Admin must
   * reassign them to another role first.
   */
  async deleteRole(organizationId: string, roleId: string): Promise<void> {
    const { rows: roleRows } = await this.db.query<{ id: string; is_system: boolean }>(
      `SELECT id, is_system FROM roles WHERE id = $1 AND organization_id = $2`,
      [roleId, organizationId],
    );
    const role = roleRows[0];
    if (!role) throw new NotFoundError('Role', roleId);
    if (role.is_system) throw new ValidationError('System roles cannot be deleted');

    const { rows: boundUsers } = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM user_role_bindings WHERE role_id = $1`,
      [roleId],
    );
    if (Number(boundUsers[0]?.count ?? 0) > 0) {
      throw new ValidationError('Cannot delete a role that still has users assigned — reassign them first');
    }

    await this.db.query(`DELETE FROM roles WHERE id = $1 AND organization_id = $2`, [roleId, organizationId]);
  }
}
