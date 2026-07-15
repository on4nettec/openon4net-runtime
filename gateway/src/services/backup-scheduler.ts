import type { AppContext } from '../context.js';
import { runBackup, pruneOldBackups } from './backup-service.js';

const CHECK_INTERVAL_MS = 60 * 60_000; // hourly tick — actual cadence gated by BACKUP_INTERVAL_HOURS below

/**
 * Opt-in, whole-DB backups (RT-071) — unlike every other scheduler in this
 * codebase, this isn't per-org (a database dump has no org boundary).
 * Writes to local disk only: wiring real off-host storage (S3/GCS) needs
 * cloud credentials this environment doesn't have, so that upload step is
 * an explicitly documented gap (see docs/spect/09_TASKS's DR runbook), not
 * faked here. lastBackupAt is tracked in-memory, not persisted — a missed
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

    try {
      const { file } = runBackup(ctx.env.DATABASE_URL, ctx.env.BACKUP_DIR);
      console.log(`[backup] wrote ${file}`);
      const pruned = pruneOldBackups(ctx.env.BACKUP_DIR, ctx.env.BACKUP_RETENTION_DAYS);
      if (pruned > 0) console.log(`[backup] pruned ${pruned} backup(s) older than ${ctx.env.BACKUP_RETENTION_DAYS} days`);
    } catch (err) {
      console.error('[backup] failed:', err instanceof Error ? err.message : err);
    }
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
