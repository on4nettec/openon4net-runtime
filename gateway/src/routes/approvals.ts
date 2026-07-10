import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { ApprovalService } from '../services/approval-service.js';
import { AuditService } from '../services/audit-service.js';
import { ChatService } from '../services/chat-service.js';

export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): void {
  const approvalService = new ApprovalService(ctx.db);
  const auditService = new AuditService(ctx.db);
  const chatService = new ChatService(ctx.db, ctx.redis, ctx.providerConfigService, ctx.env, ctx.embeddingService);

  app.get('/v1/approvals/pending', async (request) => {
    requirePermission(request, 'approvals:read');
    return approvalService.listPending(request.auth.organizationId);
  });

  app.post<{ Params: { id: string } }>('/v1/approvals/:id/approve', async (request) => {
    requirePermission(request, 'approvals:approve');
    const entry = await approvalService.getPendingById(request.auth.organizationId, request.params.id);
    if (!entry.agentId) throw new ValidationError('Approval entry has no associated agent');

    await approvalService.resolve(request.auth.organizationId, entry.id, 'approved', request.auth.userId);
    await auditService.logAction({
      organizationId: request.auth.organizationId,
      agentId: entry.agentId,
      userId: request.auth.userId,
      actionType: 'approval-approve',
      actionData: { traceId: request.traceId, approvalId: entry.id },
      approvalStatus: 'approved',
    });

    // Re-run the originally-queued chat now that a human has signed off.
    // skipApprovalGate=true — it's already been through the human-in-the-loop
    // gate, re-running prepare()'s cost-estimate check would be redundant.
    const outcome = await chatService.chat(
      {
        organizationId: request.auth.organizationId,
        userId: (entry.actionData.userId as string | undefined) ?? request.auth.userId,
        agentId: entry.agentId,
        message: entry.actionData.message as string,
        conversationId: (entry.actionData.conversationId as string | null) ?? undefined,
        traceId: request.traceId,
      },
      true,
    );

    return outcome;
  });

  app.post<{ Params: { id: string } }>('/v1/approvals/:id/reject', async (request) => {
    requirePermission(request, 'approvals:approve');
    const entry = await approvalService.getPendingById(request.auth.organizationId, request.params.id);

    await approvalService.resolve(request.auth.organizationId, entry.id, 'rejected', request.auth.userId);
    await auditService.logAction({
      organizationId: request.auth.organizationId,
      agentId: entry.agentId,
      userId: request.auth.userId,
      actionType: 'approval-reject',
      actionData: { traceId: request.traceId, approvalId: entry.id },
      approvalStatus: 'rejected',
    });

    return { status: 'rejected', approvalId: entry.id };
  });
}
