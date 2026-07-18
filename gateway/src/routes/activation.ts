import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { checkIn } from '../services/activation-client.js';
import { ActivationConfigService } from '../services/activation-config-service.js';
import { AuditService } from '../services/audit-service.js';

/**
 * RT-092 — lets an admin type in the activation code from the dashboard
 * (first-run page) instead of only ever setting ACTIVATION_KEY as an env
 * var and restarting. Same `config:write` permission gate as the LLM
 * provider settings (routes/config.ts) — another admin-only, deployment-
 * level, self-host setting.
 */
export function registerActivationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const activationConfigService = new ActivationConfigService(ctx.db, ctx.env);

  app.get('/v1/activation/status', async (request) => {
    requirePermission(request, 'config:write');
    return {
      configured: ctx.activationState.isConfigured(),
      isActivated: ctx.activationState.isActivated(),
      lastCheckIn: ctx.activationState.lastCheckIn,
    };
  });

  app.post<{ Body: { activationCode?: string } }>('/v1/activation/configure', async (request) => {
    requirePermission(request, 'config:write');
    const activationCode = (request.body ?? {}).activationCode?.trim();
    if (!activationCode) throw new ValidationError('activationCode is required');
    if (!ctx.env.CONTROL_PLANE_URL) {
      throw new ValidationError('CONTROL_PLANE_URL is not configured for this deployment');
    }

    // Validate BEFORE persisting — an invalid code must never be saved to
    // activation_config, matching provider-config-service.ts's own
    // "test the value, then store it" discipline for sensitive config.
    const result = await checkIn(ctx.env, activationCode);
    if (!result) {
      throw new ValidationError('Activation code was rejected, or Control Plane is unreachable right now');
    }

    await activationConfigService.setActivationKey(activationCode, request.auth.userId);
    ctx.activationState.markConfigured();
    ctx.activationState.recordSuccess(result);

    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'activation-configure',
      actionData: { traceId: request.traceId, organizationName: result.organizationName, plan: result.plan },
    });

    return {
      organizationName: result.organizationName,
      plan: result.plan,
      status: result.status,
    };
  });
}
