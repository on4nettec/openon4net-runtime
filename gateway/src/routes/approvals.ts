import type { FastifyInstance } from 'fastify';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { ApprovalService } from '../services/approval-service.js';
import { AuditService } from '../services/audit-service.js';
import { ChatService } from '../services/chat-service.js';
import { WorkflowExecutor } from '../services/workflow-executor.js';
import { sendTelegramMessage } from '../connectors/telegram-connector.js';
import { sendWebhook } from '../connectors/webhook-connector.js';

interface PendingToolCall {
  agentId: string;
  tool: 'telegram-send' | 'webhook-send';
  params: Record<string, unknown>;
}

/** RT-056 — executes a direct tool call that was gated by an `action_type_in` policy (see routes/tools.ts's checkPolicyGate). Params were already Zod-validated once at enqueue time. */
async function executePendingToolCall(ctx: AppContext, call: PendingToolCall): Promise<unknown> {
  if (call.tool === 'telegram-send') {
    if (!ctx.env.TELEGRAM_BOT_TOKEN) throw new ValidationError('Telegram connector is not configured (TELEGRAM_BOT_TOKEN unset)');
    return sendTelegramMessage(ctx.env.TELEGRAM_BOT_TOKEN, call.params.chatId as string, call.params.message as string);
  }
  return sendWebhook(call.params.url as string, call.params.payload as Record<string, unknown>);
}

export function registerApprovalRoutes(app: FastifyInstance, ctx: AppContext): void {
  const approvalService = new ApprovalService(ctx.db);
  const auditService = new AuditService(ctx.db);
  const chatService = new ChatService(
    ctx.db,
    ctx.redis,
    ctx.providerConfigService,
    ctx.env,
    ctx.embeddingService,
    ctx.policyService,
  );

  app.get('/v1/approvals/pending', async (request) => {
    requirePermission(request, 'approvals:read');
    return approvalService.listPending(request.auth.organizationId);
  });

  app.post<{ Params: { id: string } }>('/v1/approvals/:id/approve', async (request) => {
    requirePermission(request, 'approvals:approve');
    const entry = await approvalService.getPendingById(request.auth.organizationId, request.params.id);

    await approvalService.resolve(request.auth.organizationId, entry.id, 'approved', request.auth.userId);
    await auditService.logAction({
      organizationId: request.auth.organizationId,
      agentId: entry.agentId,
      userId: request.auth.userId,
      actionType: 'approval-approve',
      actionData: { traceId: request.traceId, approvalId: entry.id },
      approvalStatus: 'approved',
    });

    // A workflow `human` step (RT-042's generalized queue is what makes
    // this possible — see workflow-executor.ts) vs. the original chat
    // cost/policy trigger are told apart by this discriminator.
    const workflowRunId = entry.actionData.workflowRunId as string | undefined;
    if (workflowRunId) {
      await new WorkflowExecutor(ctx).resumeFromApproval(workflowRunId, true, request.auth.userId);
      return { status: 'approved', approvalId: entry.id, workflowRunId };
    }

    // RT-056 — a direct tool call gated by an action_type_in policy (see
    // routes/tools.ts's checkPolicyGate), told apart from the chat-resume
    // path the same way workflowRunId is above.
    const pendingToolCall = entry.actionData.pendingToolCall as PendingToolCall | undefined;
    if (pendingToolCall) {
      const result = await executePendingToolCall(ctx, pendingToolCall);
      await auditService.logAction({
        organizationId: request.auth.organizationId,
        agentId: pendingToolCall.agentId,
        userId: request.auth.userId,
        actionType: pendingToolCall.tool === 'telegram-send' ? 'tool-telegram-send' : 'tool-webhook-send',
        actionData: { traceId: request.traceId, approvalId: entry.id, ...pendingToolCall.params },
        approvalStatus: 'approved',
      });
      return { status: 'approved', approvalId: entry.id, result };
    }

    if (!entry.agentId) throw new ValidationError('Approval entry has no associated agent');

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

    const workflowRunId = entry.actionData.workflowRunId as string | undefined;
    if (workflowRunId) {
      await new WorkflowExecutor(ctx).resumeFromApproval(workflowRunId, false, request.auth.userId);
    }

    return { status: 'rejected', approvalId: entry.id };
  });
}
