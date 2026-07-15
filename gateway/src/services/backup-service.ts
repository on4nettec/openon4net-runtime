import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface BackupResult {
  file: string;
}

function checkBinary(bin: string): boolean {
  return spawnSync(bin, ['--version'], { stdio: 'ignore' }).error === undefined;
}

export function checkPgDumpAvailable(): boolean {
  return checkBinary('pg_dump');
}

export function checkPgRestoreAvailable(): boolean {
  return checkBinary('pg_restore');
}

/**
 * Shells out to pg_dump (RT-071) rather than reimplementing Postgres's dump
 * format — -Fc (custom format) is already compressed and restorable
 * directly via pg_restore, no separate gzip step needed. Detects pg_dump's
 * absence up front with a clear error instead of a cryptic ENOENT from
 * spawnSync, since this environment (and possibly a deployment's) may not
 * have the Postgres client tools on PATH — same honesty convention as the
 * migration-extension-skip logic in migrator.ts.
 */
export function runBackup(databaseUrl: string, backupDir: string): BackupResult {
  if (!checkPgDumpAvailable()) {
    throw new Error('pg_dump is not on PATH — install the PostgreSQL client tools to use backups.');
  }
  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = join(backupDir, `o2n-backup-${timestamp}.dump`);

  const result = spawnSync('pg_dump', [databaseUrl, '-Fc', '-f', file], { stdio: 'pipe', encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`pg_dump failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
  return { file };
}

/**
 * Restores a custom-format dump produced by runBackup(). --clean --if-exists
 * drops existing objects before recreating them — this OVERWRITES the
 * target database's contents, by design (that's what "restore" means).
 */
export function runRestore(databaseUrl: string, backupFile: string): void {
  if (!checkPgRestoreAvailable()) {
    throw new Error('pg_restore is not on PATH — install the PostgreSQL client tools to use restore.');
  }
  if (!existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }
  const result = spawnSync('pg_restore', ['-d', databaseUrl, '--clean', '--if-exists', backupFile], {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`pg_restore failed: ${result.stderr || result.error?.message || 'unknown error'}`);
  }
}

/** Deletes backup files older than retentionDays — local-disk retention only, same local-disk-only scope as runBackup(). */
export function pruneOldBackups(backupDir: string, retentionDays: number): number {
  if (!existsSync(backupDir)) return 0;
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60_000;
  let pruned = 0;
  for (const name of readdirSync(backupDir)) {
    if (!name.startsWith('o2n-backup-') || !name.endsWith('.dump')) continue;
    const path = join(backupDir, name);
    if (statSync(path).mtimeMs < cutoffMs) {
      unlinkSync(path);
      pruned += 1;
    }
  }
  return pruned;
}
