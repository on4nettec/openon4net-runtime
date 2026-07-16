import type { FastifyInstance } from 'fastify';
import { NotFoundError, O2NError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { requirePermission } from '../lib/require-permission.js';
import { requireAgentAccessible } from '../lib/agent-access.js';
import { marketplaceClient } from '../services/marketplace-client.js';
import { LocalPluginService } from '../services/local-plugin-service.js';
import { PluginGrantService } from '../services/plugin-grant-service.js';
import { AuditService } from '../services/audit-service.js';

/** RT-077: a self-hosted local plugin never needs Marketplace configured at all — checked first. */
async function assertPluginExists(ctx: AppContext, organizationId: string, pluginId: string): Promise<void> {
  const local = await new LocalPluginService(ctx.db).getById(organizationId, pluginId);
  if (local) return;

  if (!ctx.env.MARKETPLACE_SERVICE_URL) {
    throw new O2NError('VALIDATION_ERROR', 'Marketplace integration is not configured (MARKETPLACE_SERVICE_URL unset)', 501);
  }
  const plugin = await marketplaceClient.getPlugin(ctx.env, pluginId);
  if (!plugin) throw new NotFoundError('Plugin', pluginId);
}

/**
 * RT-080: per-agent Plugin grants — same grant/revoke/list shape as Skills'
 * agent_skill_grants (routes/skills.ts), but Plugins have no local mirror
 * row in Runtime for Marketplace-sourced items, so existence is checked
 * against the local registry first (RT-077), then Marketplace
 * (marketplaceClient.getPlugin).
 */
export function registerPluginGrantRoutes(app: FastifyInstance, ctx: AppContext): void {
  const pluginGrantService = new PluginGrantService(ctx.db);

  app.post<{ Params: { id: string; pluginId: string } }>('/v1/agents/:id/plugins/:pluginId/grant', async (request) => {
    requirePermission(request, 'plugins:grant');
    await requireAgentAccessible(ctx, request, request.params.id);
    await assertPluginExists(ctx, request.auth.organizationId, request.params.pluginId);

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
