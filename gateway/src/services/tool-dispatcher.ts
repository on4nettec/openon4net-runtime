import { TelegramSendSchema, WebhookSendSchema, type SkillStep } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { Env } from '../env.js';
import { sendTelegramMessage } from '../connectors/telegram-connector.js';
import { sendWebhook } from '../connectors/webhook-connector.js';

export type ToolResult = { messageId: number } | { statusCode: number };

/**
 * Thin dispatch layer over the existing first-party tool connectors. Today
 * each tool (routes/tools.ts) calls its connector directly from its own
 * route — nothing generic existed for "invoke whichever tool a step names"
 * without duplicating the same if/else in skill-executor.ts. Steps are
 * restricted to the same two tools Runtime already has connectors for (see
 * SkillStepSchema's `tool` enum in packages/shared) — no new tool surface.
 *
 * Takes `Env` rather than the full `AppContext` (RT-085) — the only piece
 * this ever used was `ctx.env.TELEGRAM_BOT_TOKEN`, and narrowing the
 * dependency lets chat-service.ts's agentic tool-calling loop call this
 * directly without needing a full AppContext threaded into ChatService.
 */
export async function executeTool(step: SkillStep, env: Env): Promise<ToolResult> {
  if (step.tool === 'telegram-send') {
    const parsed = TelegramSendSchema.safeParse(step.params);
    if (!parsed.success) {
      throw new ValidationError(`Invalid params for step "${step.id}" (telegram-send)`, parsed.error.flatten());
    }
    if (!env.TELEGRAM_BOT_TOKEN) {
      throw new ValidationError('Telegram connector is not configured (TELEGRAM_BOT_TOKEN unset)');
    }
    return sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, parsed.data.chatId, parsed.data.message);
  }

  if (step.tool === 'webhook-send') {
    const parsed = WebhookSendSchema.safeParse(step.params);
    if (!parsed.success) {
      throw new ValidationError(`Invalid params for step "${step.id}" (webhook-send)`, parsed.error.flatten());
    }
    return sendWebhook(parsed.data.url, parsed.data.payload);
  }

  const exhaustiveCheck: never = step.tool;
  throw new Error(`Unknown tool: ${String(exhaustiveCheck)}`);
}
