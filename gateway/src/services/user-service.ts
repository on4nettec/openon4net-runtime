import type { User, UserCreateInput, UserUpdateInput } from '@o2n/shared';
import { NotFoundError, ValidationError } from '@o2n/governance';
import { withTransaction, type Db } from '../db.js';
import { resolveRoleId, resolveWorkspaceId } from './role-workspace-resolver.js';
import { assertSeatAvailable } from './seat-limit-service.js';

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

export interface AuthRecord {
  id: string;
  role: User['role'];
  isActive: boolean;
  passwordHash: string | null;
  oauthProvider: string | null;
  oauthSubject: string | null;
}

export class UserService {
  constructor(private db: Db) {}

  /**
   * Fields the password/oauth/magic_link providers need that toUser()
   * deliberately never exposes (password_hash especially must never reach a
   * JSON response) — kept separate from list()/findByEmail() on purpose.
   */
  async findAuthRecordByEmail(organizationId: string, email: string): Promise<AuthRecord | null> {
    const { rows } = await this.db.query<{
      id: string;
      role: User['role'];
      is_active: boolean;
      password_hash: string | null;
      oauth_provider: string | null;
      oauth_subject: string | null;
    }>(
      `SELECT id, role, is_active, password_hash, oauth_provider, oauth_subject
       FROM users WHERE organization_id = $1 AND email = $2`,
      [organizationId, email],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      role: row.role,
      isActive: row.is_active,
      passwordHash: row.password_hash,
      oauthProvider: row.oauth_provider,
      oauthSubject: row.oauth_subject,
    };
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [passwordHash, userId]);
  }

  /** Links an oauth identity to an existing user on their first successful oauth login (found by email). */
  async linkOauthIdentity(userId: string, provider: string, subject: string): Promise<void> {
    await this.db.query(`UPDATE users SET oauth_provider = $1, oauth_subject = $2 WHERE id = $3`, [
      provider,
      subject,
      userId,
    ]);
  }

  async findById(userId: string): Promise<User | null> {
    const { rows } = await this.db.query<UserRow>(`SELECT * FROM users WHERE id = $1`, [userId]);
    const row = rows[0];
    return row ? toUser(row) : null;
  }

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

  /** Creates a user and binds them to the role/workspace named in input (workspace defaults to the org's first active one). */
  async create(organizationId: string, input: UserCreateInput): Promise<User> {
    return withTransaction(this.db, async (client) => {
      const { rows: existing } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE organization_id = $1 AND email = $2`,
        [organizationId, input.email],
      );
      if (existing[0]) throw new ValidationError(`A user with email ${input.email} already exists in this organization`);
      await assertSeatAvailable(client, organizationId);

      const roleId = await resolveRoleId(client, organizationId, input.role);
      const workspaceId = await resolveWorkspaceId(client, organizationId, input.workspaceId);

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
   * role/workspaceId change re-syncs user_role_bindings too (delete
   * existing, insert one for the new role/workspace) — the current model is
   * one active role per user, same as create(). Either field alone is
   * enough to trigger a rebind (e.g. moving a user to a different workspace
   * without changing their role keeps their current role name). isActive
   * just flips the column; a deactivated user is rejected at login (see
   * services/org-service.ts) but keeps their audit history and
   * conversations (no cascade, no physical delete — mirrors agents'
   * soft-delete via status, see routes/agents.ts).
   */
  async update(organizationId: string, userId: string, input: UserUpdateInput): Promise<User> {
    return withTransaction(this.db, async (client) => {
      const { rows: existingRows } = await client.query<UserRow>(
        `SELECT * FROM users WHERE id = $1 AND organization_id = $2`,
        [userId, organizationId],
      );
      const existing = existingRows[0];
      if (!existing) throw new NotFoundError('User', userId);

      if (input.role !== undefined || input.workspaceId !== undefined) {
        const roleName = input.role ?? existing.role;
        const roleId = await resolveRoleId(client, organizationId, roleName);
        const workspaceId = await resolveWorkspaceId(client, organizationId, input.workspaceId);

        await client.query(`UPDATE users SET role = $1 WHERE id = $2`, [roleName, userId]);
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
