import type { Organization, OrganizationUpdateInput, Workspace, User, UserRole } from '@o2n/shared';
import { DEFAULT_ROLE_PERMISSIONS, NotFoundError, ValidationError } from '@o2n/governance';
import { withTransaction, type Db, type Queryable } from '../db.js';
import { UserService } from './user-service.js';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan: Organization['plan'];
  status: Organization['status'];
  settings: Record<string, unknown>;
  activation_type: Organization['activationType'];
  max_users: number | null;
  language: string;
  created_at: string;
  updated_at: string;
}

interface WorkspaceRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

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

function toOrganization(row: OrgRow): Organization {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan: row.plan,
    status: row.status,
    settings: row.settings,
    activationType: row.activation_type,
    maxUsers: row.max_users,
    language: row.language,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface Bootstrapped {
  organization: Pick<Organization, 'id' | 'name' | 'slug'>;
  workspace: Pick<Workspace, 'id' | 'name'>;
  user: Pick<User, 'id' | 'email' | 'role'>;
}

export interface OrgAndDefaultWorkspace {
  organization: Pick<Organization, 'id' | 'name' | 'slug'>;
  workspace: Pick<Workspace, 'id' | 'name'>;
}

/**
 * Dev-mode "login" doubles as org bootstrap (docs/spect/09_TASKS/
 * 08-scope-guardrails-mvp.md requires the dashboard let a user create an
 * org/workspace, and Sprint 0 has no separate registration flow — see
 * auth/providers/dev-api-key.ts). Idempotent: calling it again for the same
 * slug just logs back in as the existing default admin instead of creating
 * a duplicate org. The other auth providers (RT-015..017) use
 * findOrgAndWorkspaceBySlug below instead — they never auto-create.
 */
export class OrgService {
  constructor(private db: Db) {}

  async getById(organizationId: string): Promise<Organization> {
    const { rows } = await this.db.query<OrgRow>(`SELECT * FROM organizations WHERE id = $1`, [organizationId]);
    const row = rows[0];
    if (!row) throw new NotFoundError('Organization', organizationId);
    return toOrganization(row);
  }

  /**
   * `plan`/`status` are deliberately not editable here — those are
   * Control-Plane's job (activation/billing), not a self-service Runtime
   * setting. `settings` is a JSONB *merge* (`||`), not a wholesale replace —
   * several independent features now each own one key under it
   * (publisherSlug/publisherDisplayName for MKT-022, auditRetentionDays/
   * auditChainGenesis for RT-054/055), so one feature's partial update must
   * not clobber another's key. `language` (RT-083) IS editable here — it's
   * the org-level i18n default, an admin-facing setting same as `name`.
   */
  async update(organizationId: string, input: OrganizationUpdateInput): Promise<Organization> {
    const { rows } = await this.db.query<OrgRow>(
      `UPDATE organizations
       SET name = COALESCE($1, name),
           settings = settings || $2::jsonb,
           language = COALESCE($3, language),
           updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [input.name ?? null, JSON.stringify(input.settings ?? {}), input.language ?? null, organizationId],
    );
    const row = rows[0];
    if (!row) throw new NotFoundError('Organization', organizationId);
    return toOrganization(row);
  }

  /**
   * RT-081 — written only by activation-scheduler.ts on every successful
   * Control Plane check-in. Never exposed through the self-service update()
   * path above — same "Control-Plane's job, not a Runtime setting" rule as
   * plan/status.
   */
  async updateActivationInfo(
    organizationId: string,
    activationType: 'personal' | 'organizational',
    maxUsers: number | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE organizations SET activation_type = $1, max_users = $2, updated_at = NOW() WHERE id = $3`,
      [activationType, maxUsers, organizationId],
    );
  }

  /**
   * Read-only lookup for the auth providers that don't auto-bootstrap
   * (password/magic_link/oauth — only dev_api_key does, see
   * getOrCreateBootstrapped). Returns null on any missing piece so callers
   * can fold "org doesn't exist" into the same generic error as "wrong
   * credentials", instead of leaking which one it was.
   */
  async findOrgAndWorkspaceBySlug(slug: string): Promise<OrgAndDefaultWorkspace | null> {
    const { rows: orgRows } = await this.db.query<OrgRow>(`SELECT * FROM organizations WHERE slug = $1`, [slug]);
    const org = orgRows[0];
    if (!org) return null;

    const { rows: wsRows } = await this.db.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
      [org.id],
    );
    const workspace = wsRows[0];
    if (!workspace) return null;

    return {
      organization: { id: org.id, name: org.name, slug: org.slug },
      workspace: { id: workspace.id, name: workspace.name },
    };
  }

  /** Used by magic_link verify, which only has a user_id (from magic_link_tokens) to start from. */
  async getOrgAndWorkspaceForUser(userId: string): Promise<OrgAndDefaultWorkspace | null> {
    const { rows: userRows } = await this.db.query<{ organization_id: string }>(
      `SELECT organization_id FROM users WHERE id = $1`,
      [userId],
    );
    const organizationId = userRows[0]?.organization_id;
    if (!organizationId) return null;

    const { rows: orgRows } = await this.db.query<OrgRow>(`SELECT * FROM organizations WHERE id = $1`, [
      organizationId,
    ]);
    const org = orgRows[0];
    if (!org) return null;

    const { rows: wsRows } = await this.db.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
      [org.id],
    );
    const workspace = wsRows[0];
    if (!workspace) return null;

    return {
      organization: { id: org.id, name: org.name, slug: org.slug },
      workspace: { id: workspace.id, name: workspace.name },
    };
  }

  async getOrCreateBootstrapped(slug: string, name: string, email?: string): Promise<Bootstrapped> {
    const existing = await this.db.query<OrgRow>(`SELECT * FROM organizations WHERE slug = $1`, [slug]);
    if (existing.rows[0]) {
      return this.loadExisting(existing.rows[0], email);
    }
    return this.createNew(slug, name);
  }

  /**
   * email is optional (see AuthTokenRequestSchema) — unset means "sign in as
   * the org's admin", matching the original single-admin-only behavior.
   * When set, it must match an already-created user (see routes/users.ts) —
   * this never auto-creates a user, only the very first bootstrap does that.
   */
  private async loadExisting(orgRow: OrgRow, email?: string): Promise<Bootstrapped> {
    const { rows: workspaces } = await this.db.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
      [orgRow.id],
    );
    const workspace = workspaces[0];
    if (!workspace) {
      throw new Error(`Organization ${orgRow.slug} is missing its default workspace`);
    }

    if (email) {
      const user = await new UserService(this.db).findByEmail(orgRow.id, email);
      if (!user) throw new NotFoundError('User', email);
      if (!user.isActive) throw new ValidationError('This user account has been deactivated');
      return {
        organization: { id: orgRow.id, name: orgRow.name, slug: orgRow.slug },
        workspace: { id: workspace.id, name: workspace.name },
        user: { id: user.id, email: user.email, role: user.role },
      };
    }

    const { rows: users } = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE organization_id = $1 AND role = 'admin' AND is_active = true ORDER BY created_at LIMIT 1`,
      [orgRow.id],
    );
    const user = users[0];
    if (!user) {
      throw new Error(`Organization ${orgRow.slug} has no active admin user`);
    }
    return {
      organization: { id: orgRow.id, name: orgRow.name, slug: orgRow.slug },
      workspace: { id: workspace.id, name: workspace.name },
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  private async createNew(slug: string, name: string): Promise<Bootstrapped> {
    return withTransaction(this.db, async (client) => {
      const { rows: orgRows } = await client.query<OrgRow>(
        `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *`,
        [name, slug],
      );
      const org = orgRows[0];
      if (!org) throw new Error('Insert did not return a row');

      const { rows: wsRows } = await client.query<WorkspaceRow>(
        `INSERT INTO workspaces (organization_id, name) VALUES ($1, $2) RETURNING *`,
        [org.id, 'Default Workspace'],
      );
      const workspace = wsRows[0];
      if (!workspace) throw new Error('Insert did not return a row');

      const { rows: userRows } = await client.query<UserRow>(
        `INSERT INTO users (email, name, role, organization_id) VALUES ($1, $2, 'admin', $3) RETURNING *`,
        [`admin@${slug}.local`, 'Admin', org.id],
      );
      const user = userRows[0];
      if (!user) throw new Error('Insert did not return a row');

      await seedRoles(client, org.id, workspace.id, user.id, user.role);

      return {
        organization: { id: org.id, name: org.name, slug: org.slug },
        workspace: { id: workspace.id, name: workspace.name },
        user: { id: user.id, email: user.email, role: user.role },
      };
    });
  }
}

/** DB-backed RBAC seed (migrations/0007_rbac.sql) — mirrors that migration's backfill for orgs created after it ran. */
async function seedRoles(
  client: Queryable,
  organizationId: string,
  workspaceId: string,
  adminUserId: string,
  adminRole: string,
): Promise<void> {
  const roleIdByName = new Map<string, string>();
  for (const roleName of Object.keys(DEFAULT_ROLE_PERMISSIONS) as UserRole[]) {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO roles (organization_id, name, is_system) VALUES ($1, $2, true) RETURNING id`,
      [organizationId, roleName],
    );
    const roleId = rows[0]?.id;
    if (!roleId) throw new Error('Insert did not return a row');
    roleIdByName.set(roleName, roleId);

    for (const permission of DEFAULT_ROLE_PERMISSIONS[roleName]) {
      await client.query(`INSERT INTO role_permissions (role_id, permission) VALUES ($1, $2)`, [
        roleId,
        permission,
      ]);
    }
  }

  const adminRoleId = roleIdByName.get(adminRole);
  if (!adminRoleId) throw new Error(`No seeded role matches admin user's role: ${adminRole}`);
  await client.query(`INSERT INTO user_role_bindings (user_id, role_id, workspace_id) VALUES ($1, $2, $3)`, [
    adminUserId,
    adminRoleId,
    workspaceId,
  ]);
}
