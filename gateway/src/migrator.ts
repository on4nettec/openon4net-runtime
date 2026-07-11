import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(moduleDir, '..', '..', 'migrations');

/**
 * Some migrations require an optional Postgres extension (e.g. 0008's
 * pgvector) that isn't installed on every deployment — that's a deliberate
 * "silently fall back" feature (see EMBEDDING_MODEL in env.ts), not a
 * config error, so it must not fail-fast startup. Detected generically by
 * scanning for `CREATE EXTENSION IF NOT EXISTS <name>` and checking
 * pg_available_extensions, rather than hardcoding "0008" — skipped
 * migrations are NOT recorded as applied, so they retry automatically once
 * the extension becomes available.
 */
async function requiredExtensionIsAvailable(client: pg.Client, sql: string): Promise<boolean> {
  const match = /CREATE EXTENSION IF NOT EXISTS\s+(\w+)/i.exec(sql);
  if (!match) return true;
  const { rows } = await client.query('SELECT 1 FROM pg_available_extensions WHERE name = $1', [match[1]]);
  return rows.length > 0;
}

/**
 * RT-029: applies every migrations/*.sql file (sorted) exactly once, tracked
 * in a `schema_migrations` table, under a Postgres advisory lock (so two
 * gateway replicas booting at once don't race each other). Unlike
 * openon4net-control-plane's migrate.mjs, this repo's migrations are NOT
 * written idempotently (plain CREATE TABLE, ALTER TABLE ADD COLUMN, no IF
 * NOT EXISTS guards), so blindly re-running everything would fail on the
 * second run — hence the tracking table instead.
 *
 * Used two ways: called from index.ts at startup (when DB_AUTO_MIGRATE
 * isn't disabled), and from scripts/migrate.mjs as a standalone CLI for
 * manual runs (`pnpm run migrate`) when it is.
 */
export async function runMigrations(databaseUrl: string, log: (msg: string) => void = console.log): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`SELECT pg_advisory_lock(hashtext('o2n_runtime_migrations')::bigint)`);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ DEFAULT NOW()
         )`,
      );
      const { rows } = await client.query<{ version: string }>('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => r.version));

      const files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = readFileSync(path.join(migrationsDir, file), 'utf8');

        if (!(await requiredExtensionIsAvailable(client, sql))) {
          log(`skipping ${file}: required extension not available on this Postgres instance`);
          continue;
        }

        log(`applying migration ${file}`);
        try {
          await client.query('BEGIN');
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw new Error(`Migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(hashtext('o2n_runtime_migrations')::bigint)`);
    }
  } finally {
    await client.end();
  }
}
