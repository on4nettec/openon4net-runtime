import type { Db } from '../db.js';

/**
 * createTestFixture() inserts org/workspace/user rows directly (no
 * OrgService.createNew(), so no seedRoles() either) — tests that exercise
 * role-name lookups (UserService, InvitationService) need at least one real
 * `roles` row for the fixture's org. Cleaned up automatically: roles.organization_id
 * has ON DELETE CASCADE (migrations/0007_rbac.sql), same as cleanupTestFixture
 * already relies on for workspaces/agents.
 */
export async function seedRole(db: Db, organizationId: string, name: string, permissions: string[] = []): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO roles (organization_id, name, is_system) VALUES ($1, $2, false) RETURNING id`,
    [organizationId, name],
  );
  const roleId = rows[0]!.id;
  for (const permission of permissions) {
    await db.query(`INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`, [roleId, permission]);
  }
  return roleId;
}
