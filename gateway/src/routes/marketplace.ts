import type { FastifyInstance } from 'fastify';
import { ActivationRequiredError, O2NError, ValidationError } from '@o2n/governance';
import type { SkillDefinition } from '@o2n/shared';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { marketplaceClient } from '../services/marketplace-client.js';
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

  app.post<{ Params: { id: string } }>('/v1/marketplace/plugins/:id/install', async (request) => {
    requirePermission(request, 'marketplace:install');
    assertMarketplaceConfigured(ctx);
    if (!ctx.activationState.isActivated()) throw new ActivationRequiredError();

    const result = await marketplaceClient.installPlugin(ctx.env, request.params.id, request.auth.organizationId);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'marketplace-install-plugin',
      actionData: { traceId: request.traceId, pluginId: request.params.id },
    });
    return result;
  });

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
}
