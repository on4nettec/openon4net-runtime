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

  /**
   * RT-090: replaces the old POST /chat/stream SSE endpoint. A WebSocket
   * handshake is always a GET, and the browser's native WebSocket
   * constructor can't set an Authorization header — the token/org id ride
   * along as query params instead (see plugins/auth.ts's isWsUpgrade
   * branch), scoped there to upgrade requests only so a normal REST call
   * can't use the same shortcut.
   *
   * The connection stays open for the agent's whole chat session: the
   * client sends one `{ message, conversationId? }` JSON frame per turn and
   * gets back a run of `ChatStreamEvent`-shaped frames ending in `done` (or
   * `requires_approval`/`error`). `busy` rejects a second turn sent before
   * the first has finished, since interleaving two chatStream() generators
   * on one socket would interleave their tokens in the output.
   */
  app.get<{ Params: { id: string } }>(
    '/v1/agents/:id/chat/ws',
    {
      websocket: true,
      // requirePermission() is synchronous and void — as a bare (non-async)
      // preHandler, Fastify's hook runner gets neither a resolved promise
      // nor a called `done()` callback and hangs the connection forever.
      // Wrapping it in an async function gives it a real promise to await.
      preHandler: [checkRateLimit, async (request: FastifyRequest) => requirePermission(request, 'agents:chat')],
    },
    (socket, request: FastifyRequest<{ Params: { id: string } }>) => {
      let busy = false;

      socket.on('message', (raw: Buffer) => {
        if (busy) {
          socket.send(JSON.stringify({ type: 'error', message: 'A message is already in progress on this connection' }));
          return;
        }

        let body: unknown;
        try {
          body = JSON.parse(raw.toString());
        } catch {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid JSON payload' }));
          return;
        }

        const parsed = ChatRequestSchema.safeParse(body);
        if (!parsed.success) {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid chat payload' }));
          return;
        }

        busy = true;
        void (async () => {
          try {
            for await (const event of chatService.chatStream({
              organizationId: request.auth.organizationId,
              userId: request.auth.userId,
              agentId: request.params.id,
              message: parsed.data.message,
              conversationId: parsed.data.conversationId,
              traceId: request.traceId,
            })) {
              socket.send(JSON.stringify(event));
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : 'Unknown error';
            socket.send(JSON.stringify({ type: 'error', message, traceId: request.traceId }));
          } finally {
            busy = false;
          }
        })();
      });
    },
  );
}
