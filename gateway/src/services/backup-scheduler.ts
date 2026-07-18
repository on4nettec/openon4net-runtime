import type { AppContext } from '../context.js';
import { runBackup, pruneOldBackups, uploadBackupToCloud } from './backup-service.js';
import { isObjectStorageConfigured } from '../lib/object-storage.js';

const CHECK_INTERVAL_MS = 60 * 60_000; // hourly tick — actual cadence gated by BACKUP_INTERVAL_HOURS below

/**
 * Opt-in, whole-DB backups (RT-071) — unlike every other scheduler in this
 * codebase, this isn't per-org (a database dump has no org boundary).
 * Always writes to local disk first; additionally uploads to MinIO/S3
 * (same object storage RT-025/RT-030 already wired up) whenever
 * isObjectStorageConfigured() is true — self-hosted orgs without object
 * storage configured keep the exact local-disk-only behavior this had
 * before. lastBackupAt is tracked in-memory, not persisted — a missed
 * backup after a restart just means the next hourly tick catches up, same
 * tolerance every other interval-based scheduler in this codebase has.
 */
export function startBackupScheduler(ctx: AppContext): () => void {
  if (!ctx.env.BACKUP_ENABLED) return () => {};

  let lastBackupAt = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - lastBackupAt < ctx.env.BACKUP_INTERVAL_HOURS * 60 * 60_000) return;
    lastBackupAt = now;

    (async () => {
      try {
        const { file } = runBackup(ctx.env.DATABASE_URL, ctx.env.BACKUP_DIR);
        console.log(`[backup] wrote ${file}`);
        if (isObjectStorageConfigured(ctx.env)) {
          const uploadedKey = await uploadBackupToCloud(ctx.env, file);
          if (uploadedKey) console.log(`[backup] uploaded to object storage: ${uploadedKey}`);
        }
        const pruned = pruneOldBackups(ctx.env.BACKUP_DIR, ctx.env.BACKUP_RETENTION_DAYS);
        if (pruned > 0) console.log(`[backup] pruned ${pruned} backup(s) older than ${ctx.env.BACKUP_RETENTION_DAYS} days`);
      } catch (err) {
        console.error('[backup] failed:', err instanceof Error ? err.message : err);
      }
    })();
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
