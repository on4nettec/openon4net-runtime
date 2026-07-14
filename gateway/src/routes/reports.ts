import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { buildReport, type ReportPeriod } from '../services/report-service.js';

/** On-demand counterpart to report-scheduler.ts (RT-061) — works whether or not the org has reporting/SMTP enabled. */
export function registerReportRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get<{ Querystring: { period?: string } }>('/v1/reports/latest', async (request) => {
    requirePermission(request, 'audit:read');
    const period: ReportPeriod = request.query.period === 'weekly' ? 'weekly' : 'daily';
    return buildReport(ctx.db, request.auth.organizationId, period);
  });
}
