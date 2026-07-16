import type { FastifyInstance } from 'fastify';
import { NotFoundError, O2NError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { requirePermission } from '../lib/require-permission.js';
import { requireAgentAccessible } from '../lib/agent-access.js';
import { marketplaceClient } from '../services/marketplace-client.js';
import { PluginGrantService } from '../services/plugin-grant-service.js';
import { AuditService } from '../services/audit-service.js';

function assertMarketplaceConfigured(ctx: AppContext): void {
  if (!ctx.env.MARKETPLACE_SERVICE_URL) {
    throw new O2NError('VALIDATION_ERROR', 'Marketplace integration is not configured (MARKETPLACE_SERVICE_URL unset)', 501);
  }
}

/**
 * RT-080: per-agent Plugin grants — same grant/revoke/list shape as Skills'
 * agent_skill_grants (routes/skills.ts), but Plugins have no local mirror
 * row in Runtime, so existence is checked against Marketplace itself
 * (marketplaceClient.getPlugin) instead of a local org-scope query.
 */
export function registerPluginGrantRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pluginGrantService = new PluginGrantService(ctx.db);

  app.post<{ Params: { id: string; pluginId: string } }>('/v1/agents/:id/plugins/:pluginId/grant', async (request) => {
    requirePermission(request, 'plugins:grant');
    await requireAgentAccessible(ctx, request, request.params.id);
    assertMarketplaceConfigured(ctx);
    const plugin = await marketplaceClient.getPlugin(ctx.env, request.params.pluginId);
    if (!plugin) throw new NotFoundError('Plugin', request.params.pluginId);

    return withTransaction(ctx.db, async (client) => {
      const grant = await new PluginGrantService(client).grant(request.params.id, request.params.pluginId, request.auth.userId);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: request.params.id,
        userId: request.auth.userId,
        actionType: 'plugin-grant',
        actionData: { traceId: request.traceId, pluginId: request.params.pluginId },
      });
      return grant;
    });
  });

  app.delete<{ Params: { id: string; pluginId: string } }>(
    '/v1/agents/:id/plugins/:pluginId/grant',
    async (request, reply) => {
      requirePermission(request, 'plugins:grant');
      await requireAgentAccessible(ctx, request, request.params.id);

      await withTransaction(ctx.db, async (client) => {
        await new PluginGrantService(client).revoke(request.params.id, request.params.pluginId);
        await new AuditService(client).logAction({
          organizationId: request.auth.organizationId,
          agentId: request.params.id,
          userId: request.auth.userId,
          actionType: 'plugin-revoke',
          actionData: { traceId: request.traceId, pluginId: request.params.pluginId },
        });
      });
      return reply.status(204).send();
    },
  );

  app.get<{ Params: { id: string } }>('/v1/agents/:id/plugins', async (request) => {
    requirePermission(request, 'plugins:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    return pluginGrantService.listForAgent(request.params.id);
  });
}
