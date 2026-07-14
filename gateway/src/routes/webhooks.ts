import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { WebhookEndpointService } from '../services/webhook-endpoint-service.js';
import { WorkflowExecutor } from '../services/workflow-executor.js';
import { ChatService } from '../services/chat-service.js';
import { AuditService } from '../services/audit-service.js';
import { checkFixedWindowRateLimit } from '../plugins/rate-limiter.js';

const WebhookEndpointCreateSchema = z.object({
  name: z.string().min(1).max(255),
  targetType: z.enum(['workflow', 'agent']),
  targetId: z.string().uuid(),
});

/**
 * Inbound webhooks (RT-065) — the CRUD management routes are ordinary
 * authenticated ones, but POST /v1/webhooks/:token is deliberately PUBLIC
 * (see plugins/auth.ts's PUBLIC_ROUTES): the unguessable token itself is the
 * auth, same trust model as invitation/magic-link tokens.
 */
export function registerWebhookRoutes(app: FastifyInstance, ctx: AppContext): void {
  const webhookEndpointService = new WebhookEndpointService(ctx.db);

  app.get('/v1/webhooks', async (request) => {
    requirePermission(request, 'workflows:read');
    return webhookEndpointService.list(request.auth.organizationId);
  });

  app.post('/v1/webhooks', async (request) => {
    requirePermission(request, 'workflows:create');
    const parsed = WebhookEndpointCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid webhook payload', parsed.error.flatten());

    const { endpoint, token } = await webhookEndpointService.create(
      request.auth.organizationId,
      parsed.data,
      request.auth.userId,
    );
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'webhook-endpoint-create',
      actionData: { traceId: request.traceId, endpointId: endpoint.id, targetType: endpoint.targetType },
    });
    // token is only ever returned here — the DB only ever holds its hash.
    return { ...endpoint, token };
  });

  app.delete<{ Params: { id: string } }>('/v1/webhooks/:id', async (request, reply) => {
    requirePermission(request, 'workflows:update');
    await webhookEndpointService.delete(request.auth.organizationId, request.params.id);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      userId: request.auth.userId,
      actionType: 'webhook-endpoint-delete',
      actionData: { traceId: request.traceId, endpointId: request.params.id },
    });
    return reply.status(204).send();
  });

  app.post<{ Params: { token: string }; Body: unknown }>('/v1/webhooks/:token', async (request, reply) => {
    const endpoint = await webhookEndpointService.findByToken(request.params.token);
    if (!endpoint) throw new NotFoundError('WebhookEndpoint', request.params.token);

    // Same fixed-window limiter chat routes use, keyed by the target id — a
    // flaky/abusive caller can't hammer one workflow or agent into the
    // ground via this unauthenticated entrypoint.
    await checkFixedWindowRateLimit(
      ctx.redis,
      `ratelimit:${endpoint.targetId}`,
      ctx.env.RATE_LIMIT_PER_MINUTE,
      `webhook:${endpoint.id}`,
    );

    await webhookEndpointService.markTriggered(endpoint.id);
    const traceId = randomUUID();

    if (endpoint.targetType === 'workflow') {
      const run = await new WorkflowExecutor(ctx).start(endpoint.organizationId, endpoint.targetId, null);
      await new AuditService(ctx.db).logAction({
        organizationId: endpoint.organizationId,
        userId: null,
        actionType: 'webhook-trigger-workflow',
        actionData: { traceId, endpointId: endpoint.id, workflowId: endpoint.targetId, runId: run.id },
      });
      return reply.status(202).send({ runId: run.id });
    }

    const chatService = new ChatService(ctx.db, ctx.redis, ctx.providerConfigService, ctx.env, ctx.embeddingService, ctx.policyService);
    const body = request.body as Record<string, unknown> | null;
    const message = typeof body?.message === 'string' ? body.message : JSON.stringify(body ?? {});
    const outcome = await chatService.chat({
      organizationId: endpoint.organizationId,
      userId: null,
      agentId: endpoint.targetId,
      message,
      traceId,
    });
    await new AuditService(ctx.db).logAction({
      organizationId: endpoint.organizationId,
      userId: null,
      actionType: 'webhook-trigger-agent',
      actionData: { traceId, endpointId: endpoint.id, agentId: endpoint.targetId },
    });
    return reply.status(202).send(outcome);
  });
}
