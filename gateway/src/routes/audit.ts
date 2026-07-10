import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { AuditService } from '../services/audit-service.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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
}
