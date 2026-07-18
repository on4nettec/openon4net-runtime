import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FeatureNotAvailableError, NotFoundError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { requirePermission } from '../lib/require-permission.js';
import { LocalPluginService, PLUGIN_CATEGORIES } from '../services/local-plugin-service.js';
import { AuditService } from '../services/audit-service.js';
import { GATED_PLUGIN_CATEGORY, hasFeature, MANAGED_AI_GATEWAY_FEATURE } from '../services/license-service.js';

const LocalPluginCreateBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  category: z.enum(PLUGIN_CATEGORIES).optional(),
  manifest: z.record(z.unknown()),
});

/**
 * RT-077 — self-hosted local Plugin install, no Marketplace involved at
 * all: a self-hosted admin registers their own plugin directly for their
 * org (typically a thin HTTP-provider manifest, same shape RT-079 already
 * knows how to invoke). Distinct from Marketplace's publish/sandbox-gate
 * flow (MKT-025), which is only for plugins meant to be *sold*.
 */
export function registerLocalPluginRoutes(app: FastifyInstance, ctx: AppContext): void {
  const localPluginService = new LocalPluginService(ctx.db);

  app.post('/v1/plugins', async (request) => {
    requirePermission(request, 'plugins:create');
    const parsed = LocalPluginCreateBody.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid plugin payload', parsed.error.flatten());

    // RT-028 — Development-category (devops) plugins require the org's plan
    // to include the Managed AI Gateway, same license gate as the
    // Programmer Agent role (routes/agents.ts) — per 02-ai-gateway.md §1.2.
    if (parsed.data.category === GATED_PLUGIN_CATEGORY && !hasFeature(ctx.activationState, MANAGED_AI_GATEWAY_FEATURE)) {
      await new AuditService(ctx.db).logAction({
        organizationId: request.auth.organizationId,
        userId: request.auth.userId,
        actionType: 'local-plugin-create-denied-no-license',
        actionData: { traceId: request.traceId, category: parsed.data.category, feature: MANAGED_AI_GATEWAY_FEATURE },
        status: 'failed',
      });
      throw new FeatureNotAvailableError(`"${GATED_PLUGIN_CATEGORY}" category plugins (requires Managed AI Gateway)`);
    }

    return withTransaction(ctx.db, async (client) => {
      const plugin = await new LocalPluginService(client).create(request.auth.organizationId, parsed.data, request.auth.userId);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        userId: request.auth.userId,
        actionType: 'local-plugin-create',
        actionData: { traceId: request.traceId, name: plugin.name },
      });
      return plugin;
    });
  });

  app.get('/v1/plugins', async (request) => {
    requirePermission(request, 'plugins:read');
    return localPluginService.list(request.auth.organizationId);
  });

  app.get<{ Params: { id: string } }>('/v1/plugins/:id', async (request) => {
    requirePermission(request, 'plugins:read');
    const plugin = await localPluginService.getById(request.auth.organizationId, request.params.id);
    if (!plugin) throw new NotFoundError('Local plugin', request.params.id);
    return plugin;
  });

  app.delete<{ Params: { id: string } }>('/v1/plugins/:id', async (request, reply) => {
    requirePermission(request, 'plugins:create'); // same permission that lets you create one lets you remove it
    await withTransaction(ctx.db, async (client) => {
      await new LocalPluginService(client).delete(request.auth.organizationId, request.params.id);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        userId: request.auth.userId,
        actionType: 'local-plugin-delete',
        actionData: { traceId: request.traceId, pluginId: request.params.id },
      });
    });
    return reply.status(204).send();
  });
}
