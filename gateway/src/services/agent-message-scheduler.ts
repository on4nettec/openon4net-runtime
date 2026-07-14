import { randomUUID } from 'node:crypto';
import type { AppContext } from '../context.js';
import { AgentMessageService } from './agent-message-service.js';
import { ChatService } from './chat-service.js';

const CHECK_INTERVAL_MS = 30_000; // same cadence as services/scheduler.ts

/**
 * Delivers pending agent_messages (roadmap item 16) as a system-initiated
 * chat turn on the recipient — same setInterval+disposer shape and
 * mark-before-executing anti-double-fire pattern as services/scheduler.ts.
 */
export function startAgentMessageScheduler(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    deliverPendingMessages(ctx).catch((err) => {
      console.error('Agent message delivery tick failed:', err);
    });
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function deliverPendingMessages(ctx: AppContext): Promise<void> {
  const messageService = new AgentMessageService(ctx.db);
  const pending = await messageService.listPending();

  for (const message of pending) {
    // Mark before executing, not after — an overlapping/slow tick must not deliver the same message twice.
    await messageService.markDelivered(message.id);

    const chatService = new ChatService(
      ctx.db,
      ctx.redis,
      ctx.providerConfigService,
      ctx.env,
      ctx.embeddingService,
      ctx.policyService,
    );
    try {
      await chatService.chat({
        organizationId: message.organizationId,
        userId: null, // system-initiated, no human in the loop
        agentId: message.toAgentId,
        message: message.content,
        traceId: randomUUID(),
      });
    } catch (err) {
      console.error(`Agent message delivery failed for message ${message.id}:`, err);
      await messageService.markFailed(message.id);
    }
  }
}
