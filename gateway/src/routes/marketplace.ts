import type { FastifyInstance } from 'fastify';
import { ActivationRequiredError, O2NError, PermissionDiffRequiredError, ValidationError } from '@o2n/governance';
import type { SkillDefinition } from '@o2n/shared';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import {
  marketplaceClient,
  PermissionDiffRequiredError as ClientPermissionDiffRequiredError,
  type SubmitPluginInput,
  type SubmitSkillInput,
} from '../services/marketplace-client.js';
import { SkillService } from '../services/skill-service.js';
import { AuditService } from '../services/audit-service.js';

function assertMarketplaceConfigured(ctx: AppContext): void {
  if (!ctx.env.MARKETPLACE_SERVICE_URL) {
    throw new O2NError('VALIDATION_ERROR', 'Marketplace integration is not configured (MARKETPLACE_SERVICE_URL unset)', 501);
  }
}

/**
 * Runtime's proxy onto apps/openon4net-marketplace's HTTP API — this is the
 * activation-gating enforcement point (docs/spect/06_MEETINGS/
 * 02-skills-plugins-marketplace-model.md): every install, free or paid,
 * requires ctx.activationState.isActivated() to be true first, since
 * without *some* activation relationship there's no wallet/billing context
 * to charge a paid item against either.
 */
export function registerMarketplaceRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/marketplace/plugins', async (request) => {
    requirePermission(request, 'marketplace:read');
    assertMarketplaceConfigured(ctx);
    return marketplaceClient.listPlugins(ctx.env);
  });

  app.get('/v1/marketplace/skills', async (request) => {
    requirePermission(request, 'marketplace:read');
    assertMarketplaceConfigured(ctx);
    return marketplaceClient.listSkills(ctx.env);
  });

  app.post<{ Params: { id: string }; Body: { version?: string; acknowledgePermissionDiff?: boolean } }>(
    '/v1/marketplace/plugins/:id/install',
    async (request) => {
      requirePermission(request, 'marketplace:install');
      assertMarketplaceConfigured(ctx);
      if (!ctx.activationState.isActivated()) throw new ActivationRequiredError();

      const body = (request.body ?? {}) as { version?: string; acknowledgePermissionDiff?: boolean };
      let result: Record<string, unknown>;
      try {
        result = await marketplaceClient.installPlugin(ctx.env, request.params.id, request.auth.organizationId, {
          version: body.version,
          acknowledgePermissionDiff: body.acknowledgePermissionDiff,
        });
      } catch (err) {
        // Re-thrown with the same code/details, just via Runtime's own
        // O2NError envelope so the UI handles it identically to any other
        // Runtime error (see web/app/marketplace/page.tsx's install handler).
        if (err instanceof ClientPermissionDiffRequiredError) {
          throw new PermissionDiffRequiredError(err.addedPermissions, err.fromVersion, err.toVersion);
        }
        throw err;
      }

      await new AuditService(ctx.db).logAction({
        organizationId: request.auth.organizationId,
        userId: request.auth.userId,
        actionType: 'marketplace-install-plugin',
        actionData: { traceId: request.traceId, pluginId: request.params.id },
      });
      return result;
    },
  );

  app.post<{ Params: { id: string } }>('/v1/marketplace/skills/:id/install', async (request) => {
    requirePermission(request, 'marketplace:install');
    assertMarketplaceConfigured(ctx);
    if (!ctx.activationState.isActivated()) throw new ActivationRequiredError();

    const installed = await marketplaceClient.installSkill(ctx.env, request.params.id, request.auth.organizationId);

    // Copy the definition into a local, ownerless skills row (no agentId —
    // see SkillCreateSchema) so it shows up immediately; granting it to a
    // specific agent is a separate, explicit step (POST .../skills/:id/grant).
    const skill = await new SkillService(ctx.db).create(
      request.auth.organizationId,
      { name: `Marketplace: ${request.params.id}`, definition: installed.definition as unknown as SkillDefinition },
      'marketplace',
    );

    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'marketplace-install-skill',
      actionData: { traceId: request.traceId, marketplaceSkillId: request.params.id, localSkillId: skill.id },
    });
    return { install: installed, skill };
  });

  app.patch<{ Params: { installId: string } }>('/v1/marketplace/installs/:installId/config', async (request) => {
    requirePermission(request, 'marketplace:install');
    assertMarketplaceConfigured(ctx);

    const body = request.body as { config?: unknown };
    if (typeof body.config !== 'object' || body.config === null || Array.isArray(body.config)) {
      throw new ValidationError('config must be an object');
    }

    const result = await marketplaceClient.updatePluginInstallConfig(
      ctx.env,
      request.params.installId,
      request.auth.organizationId,
      body.config as Record<string, unknown>,
    );
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'marketplace-update-install-config',
      actionData: { traceId: request.traceId, installId: request.params.installId },
    });
    return result;
  });

  // Rating requires having installed (marketplace:install, not a separate
  // permission) — an org rating something it never used isn't meaningful.
  app.post<{ Params: { id: string }; Body: { rating?: number; review?: string } }>(
    '/v1/marketplace/plugins/:id/rate',
    async (request) => {
      requirePermission(request, 'marketplace:install');
      assertMarketplaceConfigured(ctx);
      const body = (request.body ?? {}) as { rating?: number; review?: string };
      if (typeof body.rating !== 'number') throw new ValidationError('rating is required');

      const result = await marketplaceClient.ratePlugin(ctx.env, request.params.id, request.auth.organizationId, body.rating, body.review);
      await new AuditService(ctx.db).logAction({
        organizationId: request.auth.organizationId,
        userId: request.auth.userId,
        actionType: 'marketplace-rate-plugin',
        actionData: { traceId: request.traceId, pluginId: request.params.id, rating: body.rating },
      });
      return result;
    },
  );

  app.post<{ Params: { id: string }; Body: { rating?: number; review?: string } }>(
    '/v1/marketplace/skills/:id/rate',
    async (request) => {
      requirePermission(request, 'marketplace:install');
      assertMarketplaceConfigured(ctx);
      const body = (request.body ?? {}) as { rating?: number; review?: string };
      if (typeof body.rating !== 'number') throw new ValidationError('rating is required');

      const result = await marketplaceClient.rateSkill(ctx.env, request.params.id, request.auth.organizationId, body.rating, body.review);
      await new AuditService(ctx.db).logAction({
        organizationId: request.auth.organizationId,
        userId: request.auth.userId,
        actionType: 'marketplace-rate-skill',
        actionData: { traceId: request.traceId, marketplaceSkillId: request.params.id, rating: body.rating },
      });
      return result;
    },
  );

  // MKT-022: proxies onto the marketplace service's already-fully-built
  // /publisher/plugins and /publisher/skills — Runtime just never called
  // them before. There's no "publisher = this org" identity system (MVP-lite
  // shared-secret auth, see marketplace's plugins/auth.ts) — publisherSlug
  // is whatever the caller types, gated admin-only via marketplace:publish.
  app.get<{ Querystring: { publisherSlug?: string } }>('/v1/marketplace/publisher/plugins', async (request) => {
    requirePermission(request, 'marketplace:publish');
    assertMarketplaceConfigured(ctx);
    const publisherSlug = request.query.publisherSlug?.trim();
    if (!publisherSlug) throw new ValidationError('publisherSlug query parameter is required');
    return marketplaceClient.listPublisherPlugins(ctx.env, publisherSlug);
  });

  app.post<{ Body: SubmitPluginInput }>('/v1/marketplace/publisher/plugins', async (request) => {
    requirePermission(request, 'marketplace:publish');
    assertMarketplaceConfigured(ctx);
    const body = request.body as Partial<SubmitPluginInput>;
    if (!body.publisherSlug || !body.publisherDisplayName || !body.packageName || !body.name || !body.version || !body.manifest) {
      throw new ValidationError('publisherSlug, publisherDisplayName, packageName, name, version, and manifest are required');
    }

    const result = await marketplaceClient.submitPlugin(ctx.env, body as SubmitPluginInput);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'marketplace-publisher-submit-plugin',
      actionData: { traceId: request.traceId, packageName: body.packageName },
    });
    return result;
  });

  app.get<{ Querystring: { publisherSlug?: string } }>('/v1/marketplace/publisher/skills', async (request) => {
    requirePermission(request, 'marketplace:publish');
    assertMarketplaceConfigured(ctx);
    const publisherSlug = request.query.publisherSlug?.trim();
    if (!publisherSlug) throw new ValidationError('publisherSlug query parameter is required');
    return marketplaceClient.listPublisherSkills(ctx.env, publisherSlug);
  });

  app.post<{ Body: SubmitSkillInput }>('/v1/marketplace/publisher/skills', async (request) => {
    requirePermission(request, 'marketplace:publish');
    assertMarketplaceConfigured(ctx);
    const body = request.body as Partial<SubmitSkillInput>;
    if (!body.publisherSlug || !body.publisherDisplayName || !body.skillSlug || !body.name || !body.definition) {
      throw new ValidationError('publisherSlug, publisherDisplayName, skillSlug, name, and definition are required');
    }

    const result = await marketplaceClient.submitSkill(ctx.env, body as SubmitSkillInput);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'marketplace-publisher-submit-skill',
      actionData: { traceId: request.traceId, skillSlug: body.skillSlug },
    });
    return result;
  });
}
