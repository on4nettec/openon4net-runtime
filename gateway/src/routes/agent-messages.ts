import type { FastifyInstance } from 'fastify';
import { AgentMessageSendSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { requireAgentAccessible } from '../lib/agent-access.js';
import { AgentService } from '../services/agent-service.js';
import { AgentMessageService } from '../services/agent-message-service.js';
import { AuditService } from '../services/audit-service.js';

/** Roadmap item 16 (Agent Teams, weeks 31-32) — async agent-to-agent/human-to-agent messaging. */
export function registerAgentMessageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const agentService = new AgentService(ctx.db);
  const agentMessageService = new AgentMessageService(ctx.db);

  app.get<{ Params: { id: string } }>('/v1/agents/:id/messages', async (request) => {
    requirePermission(request, 'agents:read');
    await requireAgentAccessible(ctx, request, request.params.id);
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise
    return agentMessageService.listForAgent(request.auth.organizationId, request.params.id);
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/messages', async (request) => {
    requirePermission(request, 'agents:update');
    await requireAgentAccessible(ctx, request, request.params.id);
    await agentService.getById(request.auth.organizationId, request.params.id); // org-scope check, 404s otherwise
    const parsed = AgentMessageSendSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid message payload', parsed.error.flatten());

    const message = await agentMessageService.send(request.auth.organizationId, request.params.id, parsed.data.content);
    await new AuditService(ctx.db).logAction({
      organizationId: request.auth.organizationId,
      agentId: request.params.id,
      userId: request.auth.userId,
      actionType: 'agent-message-send',
      actionData: { traceId: request.traceId, messageId: message.id },
    });
    return message;
  });
}
