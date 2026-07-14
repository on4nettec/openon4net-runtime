import type { FastifyInstance } from 'fastify';
import type { AuditLog } from '@o2n/shared';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { AuditService } from '../services/audit-service.js';
import { OrgService } from '../services/org-service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const CSV_COLUMNS: (keyof AuditLog)[] = [
  'id',
  'createdAt',
  'actionType',
  'status',
  'approvalStatus',
  'agentId',
  'userId',
  'modelUsed',
  'costCents',
  'ipAddress',
  'actionData',
];

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

function toCsv(logs: AuditLog[]): string {
  const header = CSV_COLUMNS.join(',');
  const rows = logs.map((log) => CSV_COLUMNS.map((col) => csvEscape(log[col])).join(','));
  return [header, ...rows].join('\n');
}

export function registerAuditRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auditService = new AuditService(ctx.db);

  app.get<{ Querystring: { limit?: string; offset?: string; agentId?: string } }>(
    '/v1/audit',
    async (request) => {
      requirePermission(request, 'audit:read');

      const limit = Math.min(Number(request.query.limit) || DEFAULT_LIMIT, MAX_LIMIT);
      const offset = Math.max(Number(request.query.offset) || 0, 0);

      return auditService.list(request.auth.organizationId, {
        limit,
        offset,
        agentId: request.query.agentId,
      });
    },
  );

  app.get<{ Querystring: { format?: string } }>('/v1/audit/export', async (request, reply) => {
    requirePermission(request, 'audit:read');
    const format = request.query.format === 'json' ? 'json' : 'csv';
    const logs = await auditService.listAll(request.auth.organizationId);

    if (format === 'json') {
      reply.header('Content-Disposition', 'attachment; filename="audit-log.json"');
      return logs;
    }
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename="audit-log.csv"');
    return toCsv(logs);
  });

  app.get('/v1/audit/verify', async (request) => {
    requirePermission(request, 'audit:read');
    const organization = await new OrgService(ctx.db).getById(request.auth.organizationId);
    const genesis = organization.settings.auditChainGenesis as string | undefined;
    return auditService.verifyChain(request.auth.organizationId, genesis);
  });
}
