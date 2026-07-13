import { createHash, randomBytes } from 'node:crypto';
import { hash as argon2Hash } from '@node-rs/argon2';
import type { InvitationAcceptInput, InvitationCreateInput, User } from '@o2n/shared';
import { NotFoundError, ValidationError } from '@o2n/governance';
import { withTransaction, type Db } from '../db.js';
import { resolveRoleId, resolveWorkspaceId } from './role-workspace-resolver.js';

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days — longer than magic-link's 15min since a human has to receive/act on this email

interface InvitationRow {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  workspace_id: string | null;
  invited_by_user_id: string | null;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  expires_at: string;
  created_at: string;
}

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: string;
  workspaceId: string | null;
  invitedByUserId: string | null;
  status: InvitationRow['status'];
  expiresAt: string;
  createdAt: string;
}

function toInvitation(row: InvitationRow): Invitation {
  return {
    id: row.id,
    organizationId: row.organization_id,
    email: row.email,
    role: row.role,
    workspaceId: row.workspace_id,
    invitedByUserId: row.invited_by_user_id,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface AcceptResult {
  organizationId: string;
  workspaceId: string;
  user: Pick<User, 'id' | 'email' | 'role'>;
}

/** Mirrors auth/providers/magic-link.ts's token generation/hashing shape — see 0017_invitations.sql. */
export class InvitationService {
  constructor(private db: Db) {}

  async create(organizationId: string, invitedByUserId: string, input: InvitationCreateInput): Promise<{ invitation: Invitation; token: string }> {
    // A role name that doesn't exist for this org should fail fast, same
    // check UserService.create does before inserting the user.
    const { rows: roleRows } = await this.db.query<{ id: string }>(
      `SELECT id FROM roles WHERE organization_id = $1 AND name = $2`,
      [organizationId, input.role],
    );
    if (!roleRows[0]) throw new NotFoundError('Role', input.role);

    if (input.workspaceId) {
      const { rows: wsRows } = await this.db.query<{ id: string }>(
        `SELECT id FROM workspaces WHERE id = $1 AND organization_id = $2 AND status = 'active'`,
        [input.workspaceId, organizationId],
      );
      if (!wsRows[0]) throw new NotFoundError('Workspace', input.workspaceId);
    }

    const { rows: existingUserRows } = await this.db.query<{ id: string }>(
      `SELECT id FROM users WHERE organization_id = $1 AND email = $2`,
      [organizationId, input.email],
    );
    if (existingUserRows[0]) throw new ValidationError(`A user with email ${input.email} already exists in this organization`);

    const token = randomBytes(32).toString('hex');
    const { rows } = await this.db.query<InvitationRow>(
      `INSERT INTO invitations (organization_id, email, role, workspace_id, invited_by_user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + make_interval(secs => $7))
       RETURNING *`,
      [organizationId, input.email, input.role, input.workspaceId ?? null, invitedByUserId, hashToken(token), TOKEN_TTL_SECONDS],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return { invitation: toInvitation(row), token };
  }

  async listPending(organizationId: string): Promise<Invitation[]> {
    const { rows } = await this.db.query<InvitationRow>(
      `SELECT * FROM invitations WHERE organization_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map(toInvitation);
  }

  async revoke(organizationId: string, invitationId: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE invitations SET status = 'revoked' WHERE id = $1 AND organization_id = $2 AND status = 'pending' RETURNING id`,
      [invitationId, organizationId],
    );
    if (!rows[0]) throw new NotFoundError('Invitation', invitationId);
  }

  /**
   * Creates the user, binds role/workspace, sets the password (same argon2Hash
   * call as auth/providers/password.ts's /v1/auth/password/set), and marks
   * the invitation accepted — all in one transaction. Public route (no
   * session yet), so the token itself is the only credential.
   */
  async accept(token: string, input: InvitationAcceptInput): Promise<AcceptResult> {
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<InvitationRow>(
        `SELECT * FROM invitations WHERE token_hash = $1 AND status = 'pending' AND expires_at > NOW()`,
        [hashToken(token)],
      );
      const invitation = rows[0];
      if (!invitation) throw new ValidationError('This invitation is invalid, expired, or already used');

      const { rows: existingUserRows } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE organization_id = $1 AND email = $2`,
        [invitation.organization_id, invitation.email],
      );
      if (existingUserRows[0]) throw new ValidationError(`A user with email ${invitation.email} already exists in this organization`);

      const roleId = await resolveRoleId(client, invitation.organization_id, invitation.role);
      const workspaceId = await resolveWorkspaceId(client, invitation.organization_id, invitation.workspace_id ?? undefined);

      const passwordHash = await argon2Hash(input.password);
      const { rows: userRows } = await client.query<{ id: string; email: string; role: string }>(
        `INSERT INTO users (email, name, role, organization_id, password_hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, email, role`,
        [invitation.email, input.name, invitation.role, invitation.organization_id, passwordHash],
      );
      const user = userRows[0];
      if (!user) throw new Error('Insert did not return a row');

      await client.query(`INSERT INTO user_role_bindings (user_id, role_id, workspace_id) VALUES ($1, $2, $3)`, [
        user.id,
        roleId,
        workspaceId,
      ]);

      await client.query(`UPDATE invitations SET status = 'accepted' WHERE id = $1`, [invitation.id]);

      return { organizationId: invitation.organization_id, workspaceId, user };
    });
  }
}
