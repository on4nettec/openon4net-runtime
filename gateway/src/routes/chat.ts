import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ChatRequestSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { createAgentRateLimiter } from '../plugins/rate-limiter.js';
import { ChatService } from '../services/chat-service.js';

export function registerChatRoutes(app: FastifyInstance, ctx: AppContext): void {
  const chatService = new ChatService(
    ctx.db,
    ctx.redis,
    ctx.providerConfigService,
    ctx.env,
    ctx.embeddingService,
    ctx.policyService,
  );
  const checkRateLimit = createAgentRateLimiter(ctx.redis, ctx.env.RATE_LIMIT_PER_MINUTE);

  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/chat',
    { preHandler: checkRateLimit },
    async (request, reply) => {
      requirePermission(request, 'agents:chat');
      const parsed = ChatRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid chat payload', parsed.error.flatten());

      const outcome = await chatService.chat({
        organizationId: request.auth.organizationId,
        userId: request.auth.userId,
        agentId: request.params.id,
        message: parsed.data.message,
        conversationId: parsed.data.conversationId,
        traceId: request.traceId,
      });

      if (outcome.kind === 'requires_approval') {
        return reply.status(202).send({ status: 'requires_approval', approvalId: outcome.approvalId });
      }
      return {
        response: outcome.response,
        conversationId: outcome.conversationId,
        modelUsed: outcome.modelUsed,
        costCents: outcome.costCents,
        traceId: outcome.traceId,
        memoryUpdated: true,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/agents/:id/chat/stream',
    { preHandler: checkRateLimit },
    async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
      requirePermission(request, 'agents:chat');
      const parsed = ChatRequestSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError('Invalid chat payload', parsed.error.flatten());

      // Writing to reply.raw bypasses Fastify's reply pipeline entirely, so
      // @fastify/cors's onSend hook (registered in app.ts) never runs for
      // this response — its CORS header has to be set by hand here, or
      // browsers block reading the stream even though the OPTIONS preflight
      // (which @fastify/cors does intercept) succeeds.
      const origin = request.headers.origin;
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
      });

      try {
        for await (const event of chatService.chatStream({
          organizationId: request.auth.organizationId,
          userId: request.auth.userId,
          agentId: request.params.id,
          message: parsed.data.message,
          conversationId: parsed.data.conversationId,
          traceId: request.traceId,
        })) {
          if (event.type === 'token') {
            reply.raw.write(`event: token\ndata: ${JSON.stringify({ delta: event.delta })}\n\n`);
          } else if (event.type === 'requires_approval') {
            reply.raw.write(
              `event: requires-approval\ndata: ${JSON.stringify({ approvalId: event.approvalId })}\n\n`,
            );
          } else {
            reply.raw.write(
              `event: done\ndata: ${JSON.stringify({
                conversationId: event.conversationId,
                model: event.model,
                costCents: event.costCents,
                traceId: event.traceId,
                timeMs: event.timeMs,
              })}\n\n`,
            );
          }
        }
      } catch (err) {
        // Headers are already flushed for SSE, so an HTTP error status is no
        // longer possible — surface the failure as an SSE event instead.
        const message = err instanceof Error ? err.message : 'Unknown error';
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message, traceId: request.traceId })}\n\n`);
      }
      reply.raw.end();
    },
  );
}
