import type { FastifyInstance } from 'fastify';
import { LlmConfigSetSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';

/**
 * Per-org BYOK config, DB-backed override of the env-wide default (see
 * services/provider-config-service.ts). Any authenticated org member can
 * view (masked) config; only admins (config:write) can change it, since
 * this is where the org's LLM API key gets set.
 */
export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/config', async (request) => {
    const effective = await ctx.providerConfigService.getEffectiveConfig(request.auth.organizationId);
    return {
      ...effective,
      approvalThresholdCents: ctx.env.APPROVAL_THRESHOLD_CENTS,
      rateLimitPerMinute: ctx.env.RATE_LIMIT_PER_MINUTE,
    };
  });

  app.put('/v1/config', async (request) => {
    requirePermission(request, 'config:write');
    const parsed = LlmConfigSetSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid config payload', parsed.error.flatten());

    return ctx.providerConfigService.setConfig(request.auth.organizationId, request.auth.userId, parsed.data);
  });

  // A real (not mocked) minimal completion call against the org's configured
  // provider — costs a handful of tokens, gated the same as chat since it
  // spends real money on paid providers. Never throws: the settings page
  // wants a pass/fail, not a 500.
  app.post('/v1/config/test-connection', async (request) => {
    requirePermission(request, 'agents:chat');
    const start = Date.now();
    try {
      const { provider, model } = await ctx.providerConfigService.resolve(request.auth.organizationId);
      const result = await provider.complete({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        maxTokens: 5,
      });
      return { success: true, model: result.model, responseTimeMs: Date.now() - start };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
        responseTimeMs: Date.now() - start,
      };
    }
  });
}
