import type { Organization, Workspace, User } from '@o2n/shared';
import type { Db } from '../db.js';

interface OrgRow {
  id: string;
  name: string;
  slug: string;
  plan: Organization['plan'];
  status: Organization['status'];
  settings: Record<string, unknown>;
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

export interface Bootstrapped {
  organization: Pick<Organization, 'id' | 'name' | 'slug'>;
  workspace: Pick<Workspace, 'id' | 'name'>;
  user: Pick<User, 'id' | 'email' | 'role'>;
}

/**
 * Dev-mode "login" doubles as org bootstrap (docs/spect/09_TASKS/
 * 08-scope-guardrails-mvp.md requires the dashboard let a user create an
 * org/workspace, and Sprint 0 has no separate registration flow — see
 * routes/auth.ts). Idempotent: calling it again for the same slug just logs
 * back in as the existing default admin instead of creating a duplicate org.
 */
export class OrgService {
  constructor(private db: Db) {}

  async getOrCreateBootstrapped(slug: string, name: string): Promise<Bootstrapped> {
    const existing = await this.db.query<OrgRow>(`SELECT * FROM organizations WHERE slug = $1`, [slug]);
    if (existing.rows[0]) {
      return this.loadExisting(existing.rows[0]);
    }
    return this.createNew(slug, name);
  }

  private async loadExisting(orgRow: OrgRow): Promise<Bootstrapped> {
    const { rows: workspaces } = await this.db.query<WorkspaceRow>(
      `SELECT * FROM workspaces WHERE organization_id = $1 ORDER BY created_at LIMIT 1`,
      [orgRow.id],
    );
    const { rows: users } = await this.db.query<UserRow>(
      `SELECT * FROM users WHERE organization_id = $1 AND role = 'admin' ORDER BY created_at LIMIT 1`,
      [orgRow.id],
    );
    const workspace = workspaces[0];
    const user = users[0];
    if (!workspace || !user) {
      throw new Error(`Organization ${orgRow.slug} is missing its default workspace/admin user`);
    }
    return {
      organization: { id: orgRow.id, name: orgRow.name, slug: orgRow.slug },
      workspace: { id: workspace.id, name: workspace.name },
      user: { id: user.id, email: user.email, role: user.role },
    };
  }

  private async createNew(slug: string, name: string): Promise<Bootstrapped> {
    const { rows: orgRows } = await this.db.query<OrgRow>(
      `INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *`,
      [name, slug],
    );
    const org = orgRows[0];
    if (!org) throw new Error('Insert did not return a row');

    const { rows: wsRows } = await this.db.query<WorkspaceRow>(
      `INSERT INTO workspaces (organization_id, name) VALUES ($1, $2) RETURNING *`,
      [org.id, 'Default Workspace'],
    );
    const workspace = wsRows[0];
    if (!workspace) throw new Error('Insert did not return a row');

    const { rows: userRows } = await this.db.query<UserRow>(
      `INSERT INTO users (email, name, role, organization_id) VALUES ($1, $2, 'admin', $3) RETURNING *`,
      [`admin@${slug}.local`, 'Admin', org.id],
    );
    const user = userRows[0];
    if (!user) throw new Error('Insert did not return a row');

    return {
      organization: { id: org.id, name: org.name, slug: org.slug },
      workspace: { id: workspace.id, name: workspace.name },
      user: { id: user.id, email: user.email, role: user.role },
    };
  }
}
