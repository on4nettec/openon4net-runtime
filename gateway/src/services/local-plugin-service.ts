import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';
import { PLUGIN_CATEGORIES, type PluginCategory } from './local-plugin-categories.js';

export interface LocalPlugin {
  readonly id: string;
  organizationId: string;
  name: string;
  description: string | null;
  category: PluginCategory | null;
  manifest: Record<string, unknown>;
  createdByUserId: string | null;
  readonly createdAt: string;
  updatedAt: string;
}

interface LocalPluginRow {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  category: PluginCategory | null;
  manifest: Record<string, unknown>;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

function toLocalPlugin(row: LocalPluginRow): LocalPlugin {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    category: row.category,
    manifest: row.manifest,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface LocalPluginCreateInput {
  name: string;
  description?: string | undefined;
  category?: PluginCategory | undefined;
  manifest: Record<string, unknown>;
}

/**
 * RT-077 — self-hosted local Plugin registration, entirely bypassing
 * Marketplace (no publisher/submit/review/sandbox pipeline — see
 * migrations/0025_local_plugins.sql's comment). Org-scoped only: this is
 * for a self-hosted admin's own use, not for publishing/selling.
 */
export class LocalPluginService {
  constructor(private db: Queryable) {}

  async create(organizationId: string, input: LocalPluginCreateInput, createdByUserId: string): Promise<LocalPlugin> {
    const { rows } = await this.db.query<LocalPluginRow>(
      `INSERT INTO local_plugins (organization_id, name, description, category, manifest, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [organizationId, input.name, input.description ?? null, input.category ?? null, JSON.stringify(input.manifest), createdByUserId],
    );
    const row = rows[0];
    if (!row) throw new Error('Insert did not return a row');
    return toLocalPlugin(row);
  }

  async list(organizationId: string): Promise<LocalPlugin[]> {
    const { rows } = await this.db.query<LocalPluginRow>(
      `SELECT * FROM local_plugins WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId],
    );
    return rows.map(toLocalPlugin);
  }

  /** Org-scoped by design — a local plugin registered for org A must never resolve for org B, even by guessing its id. */
  async getById(organizationId: string, id: string): Promise<LocalPlugin | null> {
    const { rows } = await this.db.query<LocalPluginRow>(
      `SELECT * FROM local_plugins WHERE id = $1 AND organization_id = $2`,
      [id, organizationId],
    );
    const row = rows[0];
    return row ? toLocalPlugin(row) : null;
  }

  async delete(organizationId: string, id: string): Promise<void> {
    const { rows } = await this.db.query<{ id: string }>(
      `DELETE FROM local_plugins WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [id, organizationId],
    );
    if (!rows[0]) throw new NotFoundError('Local plugin', id);
  }
}

export { PLUGIN_CATEGORIES };
