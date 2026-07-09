import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';

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
}
