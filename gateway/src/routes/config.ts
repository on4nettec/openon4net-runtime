import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}${'•'.repeat(key.length - 8)}${key.slice(-4)}`;
}

/**
 * Read-only for Sprint 0 — editable BYOK key management is deferred to
 * Sprint 1+ (see the settings page in web/app/settings/page.tsx).
 */
export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/v1/config', async () => ({
    llmProvider: ctx.env.LLM_PROVIDER,
    llmModel: ctx.env.LLM_MODEL,
    llmApiKeyMasked: maskKey(ctx.env.LLM_API_KEY),
    approvalThresholdCents: ctx.env.APPROVAL_THRESHOLD_CENTS,
    rateLimitPerMinute: ctx.env.RATE_LIMIT_PER_MINUTE,
  }));

  // A real (not mocked) minimal completion call against the configured
  // provider — costs a handful of tokens, gated the same as chat since it
  // spends real money on paid providers. Never throws: the settings page
  // wants a pass/fail, not a 500.
  app.post('/v1/config/test-connection', async (request) => {
    requirePermission(request, 'agents:chat');
    const start = Date.now();
    try {
      const result = await ctx.llmProvider.complete({
        model: ctx.env.LLM_MODEL,
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
