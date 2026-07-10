import type { User, UserCreateInput, UserUpdateInput } from '@o2n/shared';
import { NotFoundError, ValidationError } from '@o2n/governance';
import { withTransaction, type Db } from '../db.js';

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: User['role'];
  organization_id: string;
  settings: Record<string, unknown>;
  is_active: boolean;
  created_at: string;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    organizationId: row.organization_id,
    settings: row.settings,
    isActive: row.is_active,
    createdAt: row.created_at,
  };
}

export class UserService {
  constructor(private db: Db) {}

  async list(organizationId: string): Promise<User[]> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE organization_id = $1 ORDER BY created_at`,
      [organizationId],
    );
    return rows.map(toUser);
  }

  async findByEmail(organizationId: string, email: string): Promise<User | null> {
    const { rows } = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE organization_id = $1 AND email = $2`,
      [organizationId, email],
    );
    const row = rows[0];
    return row ? toUser(row) : null;
  }

  /** Creates a user and binds them to the seeded role matching input.role, in the org's (first) workspace. */
  async create(organizationId: string, input: UserCreateInput): Promise<User> {
    return withTransaction(this.db, async (client) => {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE organization_id = $1 AND email = $2`,
        [organizationId, input.email],
      );
      if (existing[0]) throw new ValidationError(`A user with email ${input.email} already exists in this organization`);

      const { rows: roleRows } = await client.query<{ id: string }>(
        `SELECT id FROM roles WHERE organization_id = $1 AND name = $2`,
        [organizationId, input.role],
      );
      const roleId = roleRows[0]?.id;
      if (!roleId) throw new NotFoundError('Role', input.role);

      const { rows: wsRows } = await client.query<{ id: string }>(
        `SELECT id FROM workspaces WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
        [organizationId],
      );
      const workspaceId = wsRows[0]?.id;
      if (!workspaceId) throw new Error(`Organization ${organizationId} has no workspace`);

      const { rows: userRows } = await client.query<UserRow>(
        `INSERT INTO users (email, name, role, organization_id) VALUES ($1, $2, $3, $4) RETURNING *`,
        [input.email, input.name, input.role, organizationId],
      );
      const user = userRows[0];
      if (!user) throw new Error('Insert did not return a row');

      await client.query(`INSERT INTO user_role_bindings (user_id, role_id, workspace_id) VALUES ($1, $2, $3)`, [
        user.id,
        roleId,
        workspaceId,
      ]);

      return toUser(user);
    });
  }

  /**
   * role change re-syncs user_role_bindings too (delete existing, insert one
   * for the new role) — the current model is one active role per user, same
   * as create(). isActive just flips the column; a deactivated user is
   * rejected at login (see services/org-service.ts) but keeps their audit
   * history and conversations (no cascade, no physical delete — mirrors
   * agents' soft-delete via status, see routes/agents.ts).
   */
  async update(organizationId: string, userId: string, input: UserUpdateInput): Promise<User> {
    return withTransaction(this.db, async (client) => {
      const { rows: existingRows } = await client.query<UserRow>(
        `SELECT * FROM users WHERE id = $1 AND organization_id = $2`,
        [userId, organizationId],
      );
      if (!existingRows[0]) throw new NotFoundError('User', userId);

      if (input.role !== undefined) {
        const { rows: roleRows } = await client.query<{ id: string }>(
          `SELECT id FROM roles WHERE organization_id = $1 AND name = $2`,
          [organizationId, input.role],
        );
        const roleId = roleRows[0]?.id;
        if (!roleId) throw new NotFoundError('Role', input.role);

        const { rows: wsRows } = await client.query<{ id: string }>(
          `SELECT id FROM workspaces WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
          [organizationId],
        );
        const workspaceId = wsRows[0]?.id;
        if (!workspaceId) throw new Error(`Organization ${organizationId} has no workspace`);

        await client.query(`UPDATE users SET role = $1 WHERE id = $2`, [input.role, userId]);
        await client.query(`DELETE FROM user_role_bindings WHERE user_id = $1`, [userId]);
        await client.query(`INSERT INTO user_role_bindings (user_id, role_id, workspace_id) VALUES ($1, $2, $3)`, [
          userId,
          roleId,
          workspaceId,
        ]);
      }

      if (input.isActive !== undefined) {
        await client.query(`UPDATE users SET is_active = $1 WHERE id = $2`, [input.isActive, userId]);
      }

      const { rows: updatedRows } = await client.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
      const updated = updatedRows[0];
      if (!updated) throw new Error('Update did not return a row');
      return toUser(updated);
    });
  }
}
