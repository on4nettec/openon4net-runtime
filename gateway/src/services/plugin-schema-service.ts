import { createHash } from 'node:crypto';
import type { Queryable } from '../db.js';

/**
 * RT-076 (docs/spect/06_MEETINGS/04-plugin-ecosystem-architecture.md) —
 * per-(organization, plugin) storage isolation, decided as "separate
 * schema/namespace inside the shared Postgres" rather than a separate
 * database/container per plugin (no new orchestration subsystem). A plain
 * key-value table per schema — a plugin's actual data shape needs are
 * unknown ahead of time (this codebase can't predict every plugin author's
 * schema), and a generic KV store is what plugin-sdk's `PluginContext.memory`
 * already declares (`read`/`write`), so this backs that existing contract
 * rather than inventing a new one.
 */
export class PluginSchemaService {
  constructor(private db: Queryable) {}

  /**
   * Deterministic, derived from a sha256 hash (fixed [0-9a-f] alphabet) —
   * never built from raw organizationId/pluginId text, so there is no SQL
   * identifier-injection surface even though schema/table names can't be
   * parameterized like values can.
   */
  schemaName(organizationId: string, pluginId: string): string {
    const hash = createHash('sha256').update(`${organizationId}:${pluginId}`).digest('hex').slice(0, 16);
    return `plugin_${hash}`;
  }

  async ensureSchema(organizationId: string, pluginId: string): Promise<string> {
    const schema = this.schemaName(organizationId, pluginId);
    await this.db.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    await this.db.query(
      `CREATE TABLE IF NOT EXISTS "${schema}".kv (key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`,
    );
    return schema;
  }

  async readAll(organizationId: string, pluginId: string): Promise<Record<string, unknown>> {
    const schema = await this.ensureSchema(organizationId, pluginId);
    const { rows } = await this.db.query<{ key: string; value: unknown }>(`SELECT key, value FROM "${schema}".kv`);
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  async writeAll(organizationId: string, pluginId: string, state: Record<string, unknown>): Promise<void> {
    const schema = await this.ensureSchema(organizationId, pluginId);
    for (const [key, value] of Object.entries(state)) {
      await this.db.query(
        `INSERT INTO "${schema}".kv (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, JSON.stringify(value)],
      );
    }
  }
}
