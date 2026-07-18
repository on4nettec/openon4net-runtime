import type { FastifyInstance } from 'fastify';
import { NotFoundError, ValidationError } from '@o2n/governance';
import type { AppContext } from '../context.js';
import { requirePermission } from '../lib/require-permission.js';
import { requireAgentAccessible } from '../lib/agent-access.js';
import { MemoryService } from '../services/memory-service.js';

async function assertConversationBelongsToAgent(
  memoryService: MemoryService,
  agentId: string,
  conversationId: string,
) {
  const conversation = await memoryService.getConversationById(conversationId);
  // 404, not 403 — a conversation id from another agent must look identical
  // to one that never existed, same reasoning as every other org-scoped
  // getById in this codebase (e.g. workspace-file-service.ts).
  if (conversation.agentId !== agentId) throw new NotFoundError('Conversation', conversationId);
  return conversation;
}

/**
 * RT-022 — session management: an agent can have many conversations, not
 * just the single "latest" one GET /v1/agents/:id/conversation resumes.
 * Routes are agent-scoped (not a separate top-level /v1/conversations) so
 * they reuse requireAgentAccessible, same as agent-files.ts.
 */
export function registerConversationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const memoryService = new MemoryService(ctx.db, ctx.redis, ctx.env.SHORT_MEMORY_TTL_SECONDS, ctx.embeddingService);

  app.get<{ Params: { agentId: string }; Querystring: { includeArchived?: string } }>(
    '/v1/agents/:agentId/conversations',
    async (request) => {
      requirePermission(request, 'agents:read');
      await requireAgentAccessible(ctx, request, request.params.agentId);
      return memoryService.listConversations(request.params.agentId, {
        includeArchived: request.query.includeArchived === 'true',
      });
    },
  );

  app.get<{ Params: { agentId: string; conversationId: string } }>(
    '/v1/agents/:agentId/conversations/:conversationId/messages',
    async (request) => {
      requirePermission(request, 'agents:read');
      await requireAgentAccessible(ctx, request, request.params.agentId);
      const conversation = await assertConversationBelongsToAgent(
        memoryService,
        request.params.agentId,
        request.params.conversationId,
      );
      const messages = await memoryService.getRecentMessages(conversation.id, 50);
      return { conversation, messages };
    },
  );

  app.post<{ Params: { agentId: string }; Body: { title?: string } }>(
    '/v1/agents/:agentId/conversations',
    async (request) => {
      requirePermission(request, 'agents:update');
      await requireAgentAccessible(ctx, request, request.params.agentId);
      const title = (request.body ?? {}).title;
      if (title !== undefined && typeof title !== 'string') throw new ValidationError('title must be a string');
      return memoryService.createConversation(request.params.agentId, request.auth.userId, title);
    },
  );

  app.patch<{ Params: { agentId: string; conversationId: string }; Body: { title?: string } }>(
    '/v1/agents/:agentId/conversations/:conversationId',
    async (request) => {
      requirePermission(request, 'agents:update');
      await requireAgentAccessible(ctx, request, request.params.agentId);
      await assertConversationBelongsToAgent(memoryService, request.params.agentId, request.params.conversationId);
      const title = (request.body ?? {}).title;
      if (typeof title !== 'string' || title.trim().length === 0) throw new ValidationError('title is required');
      return memoryService.renameConversation(request.params.conversationId, title);
    },
  );

  app.post<{ Params: { agentId: string; conversationId: string } }>(
    '/v1/agents/:agentId/conversations/:conversationId/archive',
    async (request) => {
      requirePermission(request, 'agents:update');
      await requireAgentAccessible(ctx, request, request.params.agentId);
      await assertConversationBelongsToAgent(memoryService, request.params.agentId, request.params.conversationId);
      return memoryService.archiveConversation(request.params.conversationId);
    },
  );
}
