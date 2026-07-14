import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { answerQuestion } from '../services/nl-query-service.js';

const AskSchema = z.object({ question: z.string().min(1).max(500) });

/** RT-064 — natural-language data query, kept constrained-intent rather than raw SQL generation (see nl-query-service.ts). */
export function registerInsightRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post('/v1/insights/ask', async (request) => {
    requirePermission(request, 'audit:read');
    const parsed = AskSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid payload', parsed.error.flatten());

    return answerQuestion(ctx, request.auth.organizationId, parsed.data.question);
  });
}
