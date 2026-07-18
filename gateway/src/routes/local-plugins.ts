import type { FastifyInstance, FastifyRequest } from 'fastify';
import AdmZip from 'adm-zip';
import { z } from 'zod';
import { FeatureNotAvailableError, NotFoundError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { requirePermission } from '../lib/require-permission.js';
import { LocalPluginService, PLUGIN_CATEGORIES } from '../services/local-plugin-service.js';
import type { PluginCategory } from '../services/local-plugin-categories.js';
import { AuditService } from '../services/audit-service.js';
import { GATED_PLUGIN_CATEGORY, hasFeature, MANAGED_AI_GATEWAY_FEATURE } from '../services/license-service.js';

const LocalPluginCreateBody = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(2000).optional(),
  category: z.enum(PLUGIN_CATEGORIES).optional(),
  manifest: z.record(z.unknown()),
});

const MAX_ZIP_SIZE = 5 * 1024 * 1024; // 5MB — a manifest + small assets, not an executable bundle

/**
 * RT-028 — Development-category (devops) plugins require the org's plan to
 * include the Managed AI Gateway, same license gate as the Programmer
 * Agent role (routes/agents.ts) — per 02-ai-gateway.md §1.2. Shared by both
 * the JSON create route and the ZIP-upload route (RT-027) below.
 */
async function assertPluginCategoryAllowed(
  ctx: AppContext,
  request: FastifyRequest,
  category: PluginCategory | undefined,
): Promise<void> {
  if (category !== GATED_PLUGIN_CATEGORY) return;
  if (hasFeature(ctx.activationState, MANAGED_AI_GATEWAY_FEATURE)) return;

  await new AuditService(ctx.db).logAction({
    organizationId: request.auth.organizationId,
    userId: request.auth.userId,
    actionType: 'local-plugin-create-denied-no-license',
    actionData: { traceId: request.traceId, category, feature: MANAGED_AI_GATEWAY_FEATURE },
    status: 'failed',
  });
  throw new FeatureNotAvailableError(`"${GATED_PLUGIN_CATEGORY}" category plugins (requires Managed AI Gateway)`);
}

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

    await assertPluginCategoryAllowed(ctx, request, parsed.data.category);

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

  // RT-027 — manual ZIP upload: an admin uploads the .zip of a plugin
  // project scaffolded by `create-o2n-plugin` (packages/create-o2n-plugin),
  // which has a manifest.json at its root. Only manifest.json is ever read
  // — no other archive entry is extracted or written to disk, so there is
  // no zip-slip/path-traversal surface here at all.
  app.post('/v1/plugins/upload', async (request) => {
    requirePermission(request, 'plugins:create');
    const file = await request.file({ limits: { fileSize: MAX_ZIP_SIZE } });
    if (!file) throw new ValidationError('No file uploaded — send a multipart/form-data request with a "file" field');

    const categoryField = file.fields.category;
    const categoryRaw = categoryField && 'value' in categoryField ? categoryField.value : undefined;
    const categoryParsed = categoryRaw ? z.enum(PLUGIN_CATEGORIES).safeParse(categoryRaw) : undefined;
    if (categoryRaw && !categoryParsed?.success) {
      throw new ValidationError(`category must be one of: ${PLUGIN_CATEGORIES.join(', ')}`);
    }
    const category = categoryParsed?.success ? categoryParsed.data : undefined;

    const buffer = await file.toBuffer();
    let zip: AdmZip;
    try {
      zip = new AdmZip(buffer);
    } catch {
      throw new ValidationError('Uploaded file is not a valid zip archive');
    }

    const entry = zip.getEntry('manifest.json');
    if (!entry) throw new ValidationError('Zip archive must contain a manifest.json at its root');

    let manifest: unknown;
    try {
      manifest = JSON.parse(entry.getData().toString('utf-8'));
    } catch {
      throw new ValidationError('manifest.json is not valid JSON');
    }
    if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
      throw new ValidationError('manifest.json must contain a JSON object');
    }
    const manifestRecord = manifest as Record<string, unknown>;
    if (typeof manifestRecord.name !== 'string' || manifestRecord.name.trim().length === 0) {
      throw new ValidationError('manifest.json must have a non-empty string "name" field');
    }
    const description = typeof manifestRecord.description === 'string' ? manifestRecord.description : undefined;

    await assertPluginCategoryAllowed(ctx, request, category);

    return withTransaction(ctx.db, async (client) => {
      const plugin = await new LocalPluginService(client).create(
        request.auth.organizationId,
        { name: manifestRecord.name as string, description, category, manifest: manifestRecord },
        request.auth.userId,
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        userId: request.auth.userId,
        actionType: 'local-plugin-upload',
        actionData: { traceId: request.traceId, name: plugin.name, filename: file.filename },
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
