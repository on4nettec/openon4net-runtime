import type { FastifyInstance } from 'fastify';
import { SsoConfigSetSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { SsoConfigService } from '../services/sso-config-service.js';
import { AuditService } from '../services/audit-service.js';

/** Enterprise SSO config (RT-068/069) — same "no :id, belongs to the calling org" convention as routes/organizations.ts. */
export function registerSsoRoutes(app: FastifyInstance, ctx: AppContext): void {
  const ssoConfigService = new SsoConfigService(ctx.db, ctx.env);

  app.get('/v1/organization/sso', async (request) => {
    requirePermission(request, 'organization:read');
    return ssoConfigService.getEffectiveConfig(request.auth.organizationId);
  });

  app.put('/v1/organization/sso', async (request) => {
    requirePermission(request, 'organization:write');
    const parsed = SsoConfigSetSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid SSO config payload', parsed.error.flatten());

    const config = await ssoConfigService.setConfig(request.auth.organizationId, parsed.data);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'sso-config-set',
      actionData: { traceId: request.traceId, protocol: parsed.data.protocol },
    });
    return config;
  });

  app.delete('/v1/organization/sso', async (request, reply) => {
    requirePermission(request, 'organization:write');
    await ssoConfigService.delete(request.auth.organizationId);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'sso-config-delete',
      actionData: { traceId: request.traceId },
    });
    return reply.status(204).send();
  });
}
