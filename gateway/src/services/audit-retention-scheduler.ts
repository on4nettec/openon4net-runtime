import type { AppContext } from '../context.js';
import { AuditService } from './audit-service.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60_000; // daily — retention isn't time-sensitive the way approvals/schedules are

interface OrgSettingsRow {
  id: string;
  settings: Record<string, unknown>;
}

/**
 * Sweeps every organization once a day: an org's own
 * organizations.settings.auditRetentionDays overrides env.AUDIT_RETENTION_DAYS;
 * orgs with neither set are skipped entirely (opt-in, same as WalletService's
 * "no wallet = no cap" philosophy). Same setInterval+disposer shape as
 * approval-expiry-scheduler.ts.
 */
export function startAuditRetentionScheduler(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    sweep(ctx).catch((err) => {
      console.error('Audit retention sweep failed:', err);
    });
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function sweep(ctx: AppContext): Promise<void> {
  const { rows } = await ctx.db.query<OrgSettingsRow>(`SELECT id, settings FROM organizations`);
  const auditService = new AuditService(ctx.db);

  for (const row of rows) {
    const orgOverride = row.settings.auditRetentionDays;
    const retentionDays = typeof orgOverride === 'number' ? orgOverride : ctx.env.AUDIT_RETENTION_DAYS;
    if (!retentionDays) continue; // neither org override nor global default set — never auto-delete

    await auditService.purgeExpired(row.id, retentionDays);
  }
}
