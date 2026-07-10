import type { FastifyInstance } from 'fastify';
import { MemorySearchSchema, MemoryWriteSchema } from '@o2n/shared';
import { ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { AgentService } from '../services/agent-service.js';
import { MemoryService } from '../services/memory-service.js';

export function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const agentService = new AgentService(ctx.db);
  const memoryService = new MemoryService(ctx.db, ctx.redis, ctx.env.SHORT_MEMORY_TTL_SECONDS, ctx.embeddingService);

  app.post('/v1/memory/write', async (request) => {
    requirePermission(request, 'memory:write');
    const parsed = MemoryWriteSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid memory write payload', parsed.error.flatten());

    // Enforce org scoping: the conversation's agent must belong to this org
    // (agentService.getById() 404s otherwise) — mirrors the org check in chat.ts.
    const conversation = await memoryService.getConversationById(parsed.data.conversationId);
    await agentService.getById(request.auth.organizationId, conversation.agentId);

    return memoryService.appendMessage(conversation.id, {
      role: parsed.data.role,
      content: parsed.data.content,
    });
  });

  app.post('/v1/memory/search', async (request) => {
    requirePermission(request, 'memory:read');
    const parsed = MemorySearchSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid memory search payload', parsed.error.flatten());

    // Conversation-scoped search only — no org-wide search across all
    // conversations, no Layers 3-6 or Memory Graph (still out of MVP scope,
    // see docs/spect/DONE.md). Semantic search (pgvector cosine similarity)
    // is used when EMBEDDING_MODEL is configured; otherwise falls back to
    // the plain ILIKE search this always had.
    if (!parsed.data.conversationId) {
      throw new ValidationError('conversationId is required in this version of memory search');
    }
    const conversation = await memoryService.getConversationById(parsed.data.conversationId);
    await agentService.getById(request.auth.organizationId, conversation.agentId);

    return ctx.embeddingService.enabled
      ? memoryService.searchMessagesSemantic(conversation.id, parsed.data.query, parsed.data.limit)
      : memoryService.searchMessages(conversation.id, parsed.data.query, parsed.data.limit);
  });
}
