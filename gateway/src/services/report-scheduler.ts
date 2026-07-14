import nodemailer from 'nodemailer';
import type { AppContext } from '../context.js';
import { buildReport, reportToText, type ReportPeriod } from './report-service.js';

const CHECK_INTERVAL_MS = 24 * 60 * 60_000; // daily tick — weekly orgs are gated by lastReportSentAt below

interface OrgSettingsRow {
  id: string;
  name: string;
  settings: Record<string, unknown>;
}

function isDue(settings: Record<string, unknown>, period: ReportPeriod): boolean {
  const lastSentAt = settings.lastReportSentAt;
  if (typeof lastSentAt !== 'string') return true;
  const elapsedMs = Date.now() - new Date(lastSentAt).getTime();
  const minGapMs = (period === 'daily' ? 1 : 7) * 24 * 60 * 60_000;
  return elapsedMs >= minGapMs;
}

/**
 * Opt-in per org (organizations.settings.reportingEnabled +
 * reportingFrequency), RT-061. Only sends email when SMTP is already
 * configured (reuses the exact nodemailer setup from magic-link.ts /
 * invitations.ts) — otherwise the report is still computed and reachable via
 * GET /v1/reports/latest, so the feature degrades gracefully instead of
 * silently doing nothing. Same setInterval+disposer shape as the other
 * schedulers in this file.
 */
export function startReportScheduler(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    sweep(ctx).catch((err) => {
      console.error('Report sweep failed:', err);
    });
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function sweep(ctx: AppContext): Promise<void> {
  const { rows } = await ctx.db.query<OrgSettingsRow>(`SELECT id, name, settings FROM organizations`);

  const smtpConfigured = Boolean(ctx.env.SMTP_HOST);
  const transport = smtpConfigured
    ? nodemailer.createTransport({
        host: ctx.env.SMTP_HOST,
        port: ctx.env.SMTP_PORT,
        secure: ctx.env.SMTP_SECURE,
        auth: ctx.env.SMTP_USER ? { user: ctx.env.SMTP_USER, pass: ctx.env.SMTP_PASS } : undefined,
      })
    : null;

  for (const row of rows) {
    if (row.settings.reportingEnabled !== true) continue;
    const period: ReportPeriod = row.settings.reportingFrequency === 'weekly' ? 'weekly' : 'daily';
    if (!isDue(row.settings, period)) continue;

    const report = await buildReport(ctx.db, row.id, period);

    const recipient = row.settings.reportingEmail;
    if (transport && typeof recipient === 'string') {
      await transport.sendMail({
        from: ctx.env.EMAIL_FROM,
        to: recipient,
        subject: `Open on4net ${period} report — ${row.name}`,
        text: reportToText(report),
      });
    }

    await ctx.db.query(`UPDATE organizations SET settings = settings || $1::jsonb WHERE id = $2`, [
      JSON.stringify({ lastReportSentAt: report.generatedAt }),
      row.id,
    ]);
  }
}
