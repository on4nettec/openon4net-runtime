import type { FastifyInstance } from 'fastify';
import { AgentCreateSchema, AgentUpdateSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { withTransaction } from '../db.js';
import { requirePermission } from '../lib/require-permission.js';
import { AgentService } from '../services/agent-service.js';
import { AuditService } from '../services/audit-service.js';

export function registerAgentRoutes(app: FastifyInstance, ctx: AppContext): void {
  const agentService = new AgentService(ctx.db);

  // Every write below runs in a transaction with its own audit_logs insert —
  // an agent mutation must never be committed without an audit trail
  // (docs/spect/09_TASKS/08-scope-guardrails-mvp.md: "audit_logs برای همه actionها").

  app.post('/v1/agents', async (request) => {
    requirePermission(request, 'agents:create');
    const parsed = AgentCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid agent payload', parsed.error.flatten());

    return withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).create(request.auth.organizationId, parsed.data);
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-create',
        actionData: { traceId: request.traceId, name: agent.name, role: agent.role },
      });
      return agent;
    });
  });

  app.get('/v1/agents', async (request) => {
    requirePermission(request, 'agents:read');
    return agentService.list(request.auth.organizationId);
  });

  app.get<{ Params: { id: string } }>('/v1/agents/:id', async (request) => {
    requirePermission(request, 'agents:read');
    return agentService.getById(request.auth.organizationId, request.params.id);
  });

  app.patch<{ Params: { id: string } }>('/v1/agents/:id', async (request) => {
    requirePermission(request, 'agents:update');
    const parsed = AgentUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid agent payload', parsed.error.flatten());

    return withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).update(
        request.auth.organizationId,
        request.params.id,
        parsed.data,
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-update',
        actionData: { traceId: request.traceId, changes: parsed.data },
      });
      return agent;
    });
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/pause', async (request) => {
    requirePermission(request, 'agents:update');
    return withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).setStatus(
        request.auth.organizationId,
        request.params.id,
        'paused',
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-pause',
        actionData: { traceId: request.traceId },
      });
      return agent;
    });
  });

  // Soft-delete: sets status='terminated' rather than a physical DELETE, to
  // preserve FK integrity with conversations/audit_logs.
  app.delete<{ Params: { id: string } }>('/v1/agents/:id', async (request, reply) => {
    requirePermission(request, 'agents:update');
    await withTransaction(ctx.db, async (client) => {
      const agent = await new AgentService(client).setStatus(
        request.auth.organizationId,
        request.params.id,
        'terminated',
      );
      await new AuditService(client).logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'agent-terminate',
        actionData: { traceId: request.traceId },
      });
    });
    return reply.status(204).send();
  });
}
