import type { FastifyInstance } from 'fastify';
import { TelegramSendSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { listTools } from '../services/tool-registry.js';
import { AgentService } from '../services/agent-service.js';
import { AuditService } from '../services/audit-service.js';
import { sendTelegramMessage } from '../connectors/telegram-connector.js';

export function registerToolRoutes(app: FastifyInstance, ctx: AppContext): void {
  const agentService = new AgentService(ctx.db);
  const auditService = new AuditService(ctx.db);

  app.get('/v1/tools', async (request) => {
    requirePermission(request, 'tools:read');
    return listTools();
  });

  app.post<{ Params: { id: string } }>('/v1/agents/:id/tools/telegram-send', async (request) => {
    requirePermission(request, 'tools:telegram-send');
    const parsed = TelegramSendSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid telegram-send payload', parsed.error.flatten());

    // Org-scoped existence + active check, same pattern as chat.
    const agent = await agentService.getById(request.auth.organizationId, request.params.id);

    if (!ctx.env.TELEGRAM_BOT_TOKEN) {
      throw new ValidationError('Telegram connector is not configured (TELEGRAM_BOT_TOKEN unset)');
    }

    try {
      const result = await sendTelegramMessage(ctx.env.TELEGRAM_BOT_TOKEN, parsed.data.chatId, parsed.data.message);
      await auditService.logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'tool-telegram-send',
        actionData: { traceId: request.traceId, chatId: parsed.data.chatId, messageId: result.messageId },
        costCents: 0,
      });
      return result;
    } catch (err) {
      await auditService.logAction({
        organizationId: request.auth.organizationId,
        agentId: agent.id,
        userId: request.auth.userId,
        actionType: 'tool-telegram-send',
        actionData: { traceId: request.traceId, chatId: parsed.data.chatId },
        status: 'failed',
      });
      throw err;
    }
  });
}
