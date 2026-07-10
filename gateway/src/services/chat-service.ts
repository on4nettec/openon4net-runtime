import type { LlmCompletionResult, LlmMessage, LlmProvider } from '@o2n/llm-providers';
import type { Agent, Conversation } from '@o2n/shared';
import { AgentNotActiveError, BudgetExceededError, O2NError, requiresApproval } from '@o2n/governance';
import type { Env } from '../env.js';
import { withTransaction, type Db } from '../db.js';
import type { RedisClient } from '../redis.js';
import { AgentService } from './agent-service.js';
import { AuditService } from './audit-service.js';
import { MemoryService, AUTO_SUMMARY_EVERY_N_MESSAGES } from './memory-service.js';
import { LlmService } from './llm-service.js';
import type { ProviderConfigService } from './provider-config-service.js';
import { calculateCostCents, estimateCostCentsFromChars, estimatePromptCostCents } from './pricing.js';
import { llmCostCentsTotal } from '../observability/metrics.js';

export interface ChatParams {
  organizationId: string;
  userId: string;
  agentId: string;
  message: string;
  conversationId?: string | undefined;
  traceId: string;
}

export interface ChatSuccess {
  kind: 'success';
  response: string;
  conversationId: string;
  modelUsed: string;
  costCents: number;
  traceId: string;
}

export interface ChatRequiresApproval {
  kind: 'requires_approval';
  approvalId: string;
}

export type ChatOutcome = ChatSuccess | ChatRequiresApproval;

export type ChatStreamEvent =
  | { type: 'token'; delta: string }
  | { type: 'done'; conversationId: string; model: string; costCents: number; traceId: string; timeMs: number }
  | { type: 'requires_approval'; approvalId: string };

interface PreparedChat {
  agent: Agent;
  conversation: Conversation;
  llmMessages: LlmMessage[];
  model: string;
  promptChars: number;
  llmProvider: LlmProvider;
  providerName: string;
}

type PrepareOutcome = { kind: 'ready'; prepared: PreparedChat } | { kind: 'requires_approval'; approvalId: string };

function toLlmRole(role: 'user' | 'agent' | 'system' | 'tool'): 'user' | 'assistant' | 'system' | null {
  if (role === 'agent') return 'assistant';
  if (role === 'tool') return null; // Sprint 0 has no tool-call history to replay
  return role;
}

export class ChatService {
  private agentService: AgentService;
  private memoryService: MemoryService;

  constructor(
    private db: Db,
    private redis: RedisClient,
    private providerConfigService: ProviderConfigService,
    private env: Env,
  ) {
    this.agentService = new AgentService(db);
    this.memoryService = new MemoryService(db, redis, env.SHORT_MEMORY_TTL_SECONDS);
  }

  /**
   * Shared by chat() and chatStream(): agent/status/budget/approval checks,
   * conversation + prompt assembly. skipApprovalGate is set when re-running a
   * request that has already been through the approval queue (see
   * routes/approvals.ts) — re-checked: agent-active + hard budget cap;
   * NOT re-checked: the cost-estimate-vs-threshold gate, since a human
   * already signed off on this specific request.
   */
  private async prepare(params: ChatParams, skipApprovalGate = false): Promise<PrepareOutcome> {
    const agent = await this.agentService.getById(params.organizationId, params.agentId);
    if (agent.status !== 'active') {
      throw new AgentNotActiveError(agent.id, agent.status);
    }

    const { provider: llmProvider, model: defaultModel, providerName } = await this.providerConfigService.resolve(
      params.organizationId,
    );
    const model = agent.modelPreferences.primary ?? defaultModel;

    // Budget gate 1: agent has no budget left at all -> hard stop.
    if (agent.usedBudgetCents >= agent.monthlyBudgetCents) {
      throw new BudgetExceededError(agent.id, agent.monthlyBudgetCents);
    }

    // Budget gate 2: this specific request's estimated cost exceeds the
    // approval threshold -> human-in-the-loop (build pack §4.3), not an error.
    if (!skipApprovalGate) {
      const estimatedCostCents = estimatePromptCostCents(model, params.message.length, providerName);
      if (requiresApproval(estimatedCostCents, this.env.APPROVAL_THRESHOLD_CENTS)) {
        const approvalId = await this.enqueueApproval(params, agent.id, estimatedCostCents);
        return { kind: 'requires_approval', approvalId };
      }
    }

    const conversation = await this.memoryService.getOrCreateConversation(
      agent.id,
      params.userId,
      params.conversationId,
    );

    await this.memoryService.appendMessage(conversation.id, { role: 'user', content: params.message });

    const history = await this.memoryService.getRecentMessages(conversation.id, 10);
    const systemPrompt = `You are ${agent.name}, a ${agent.role} digital employee.`;
    const llmMessages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history
        .map((m) => {
          const role = toLlmRole(m.role);
          return role ? { role, content: m.content } : null;
        })
        .filter((m): m is LlmMessage => m !== null),
    ];
    const promptChars = llmMessages.reduce((sum, m) => sum + m.content.length, 0);

    return {
      kind: 'ready',
      prepared: { agent, conversation, llmMessages, model, promptChars, llmProvider, providerName },
    };
  }

  private async persistTurn(
    conversationId: string,
    organizationId: string,
    userId: string,
    agentId: string,
    traceId: string,
    providerName: string,
    result: { content: string; model: string; costCents: number; tokens: number },
  ): Promise<void> {
    await withTransaction(this.db, async (client) => {
      await new MemoryService(client, this.redis, this.env.SHORT_MEMORY_TTL_SECONDS).appendMessage(conversationId, {
        role: 'agent',
        content: result.content,
        model: result.model,
        costCents: result.costCents,
        tokens: result.tokens,
      });
      await new AgentService(client).addUsedBudget(organizationId, agentId, result.costCents);
      llmCostCentsTotal.inc({ provider: providerName, model: result.model }, result.costCents);
      await new AuditService(client).logAction({
        organizationId,
        agentId,
        userId,
        actionType: 'agent-chat',
        actionData: { traceId },
        modelUsed: result.model,
        costCents: result.costCents,
      });
    });
  }

  /** Wraps the actual model call so a provider failure still produces an audit_logs row (status='failed') instead of vanishing silently. */
  private async callModel(
    messages: LlmMessage[],
    model: string,
    llmProvider: LlmProvider,
    params: ChatParams,
    agentId: string,
  ): Promise<LlmCompletionResult> {
    try {
      return await new LlmService(llmProvider).completeWithRetry({ model, messages });
    } catch (err) {
      await new AuditService(this.db).logAction({
        organizationId: params.organizationId,
        agentId,
        userId: params.userId,
        actionType: 'agent-chat',
        actionData: { traceId: params.traceId, error: err instanceof O2NError ? err.message : 'unknown error' },
        modelUsed: model,
        status: 'failed',
      });
      throw err;
    }
  }

  async chat(params: ChatParams, skipApprovalGate = false): Promise<ChatOutcome> {
    const outcome = await this.prepare(params, skipApprovalGate);
    if (outcome.kind === 'requires_approval') return outcome;
    const { agent, conversation, llmMessages, model, llmProvider, providerName } = outcome.prepared;

    const result = await this.callModel(llmMessages, model, llmProvider, params, agent.id);
    const costCents = calculateCostCents(result.model, result.inputTokens, result.outputTokens, providerName);

    await this.persistTurn(
      conversation.id,
      params.organizationId,
      params.userId,
      agent.id,
      params.traceId,
      providerName,
      {
        content: result.content,
        model: result.model,
        costCents,
        tokens: result.inputTokens + result.outputTokens,
      },
    );

    await this.maybeSummarize(conversation.id, model, llmProvider);

    return {
      kind: 'success',
      response: result.content,
      conversationId: conversation.id,
      modelUsed: result.model,
      costCents,
      traceId: params.traceId,
    };
  }

  async *chatStream(params: ChatParams): AsyncGenerator<ChatStreamEvent, void, void> {
    const outcome = await this.prepare(params);
    if (outcome.kind === 'requires_approval') {
      yield { type: 'requires_approval', approvalId: outcome.approvalId };
      return;
    }
    const { agent, conversation, llmMessages, model, promptChars, llmProvider, providerName } = outcome.prepared;

    const start = Date.now();
    let full = '';
    try {
      for await (const chunk of new LlmService(llmProvider).stream({ model, messages: llmMessages })) {
        full += chunk.delta;
        yield { type: 'token', delta: chunk.delta };
      }
    } catch (err) {
      await new AuditService(this.db).logAction({
        organizationId: params.organizationId,
        agentId: agent.id,
        userId: params.userId,
        actionType: 'agent-chat',
        actionData: { traceId: params.traceId, error: err instanceof O2NError ? err.message : 'unknown error' },
        modelUsed: model,
        status: 'failed',
      });
      throw err;
    }

    const costCents = estimateCostCentsFromChars(model, promptChars, full.length, providerName);
    await this.persistTurn(
      conversation.id,
      params.organizationId,
      params.userId,
      agent.id,
      params.traceId,
      providerName,
      {
        content: full,
        model,
        costCents,
        tokens: Math.ceil((promptChars + full.length) / 4),
      },
    );

    await this.maybeSummarize(conversation.id, model, llmProvider);

    yield {
      type: 'done',
      conversationId: conversation.id,
      model,
      costCents,
      traceId: params.traceId,
      timeMs: Date.now() - start,
    };
  }

  private async enqueueApproval(params: ChatParams, agentId: string, estimatedCostCents: number): Promise<string> {
    return withTransaction(this.db, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO approval_queue (organization_id, agent_id, action_data, reason)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [
          params.organizationId,
          agentId,
          JSON.stringify({
            traceId: params.traceId,
            message: params.message,
            conversationId: params.conversationId ?? null,
            userId: params.userId,
            estimatedCostCents,
          }),
          `Estimated cost ${estimatedCostCents} cents exceeds threshold ${this.env.APPROVAL_THRESHOLD_CENTS} cents`,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('Insert did not return a row');
      await new AuditService(client).logAction({
        organizationId: params.organizationId,
        agentId,
        userId: params.userId,
        actionType: 'agent-chat',
        actionData: { traceId: params.traceId, estimatedCostCents },
        status: 'pending',
        approvalStatus: 'pending',
      });
      return row.id;
    });
  }

  private async maybeSummarize(conversationId: string, model: string, llmProvider: LlmProvider): Promise<void> {
    const conversation = await this.memoryService.getConversationById(conversationId);
    if (conversation.messageCount === 0 || conversation.messageCount % AUTO_SUMMARY_EVERY_N_MESSAGES !== 0) {
      return;
    }
    const recent = await this.memoryService.getRecentMessages(conversationId, AUTO_SUMMARY_EVERY_N_MESSAGES);
    const transcript = recent.map((m) => `${m.role}: ${m.content}`).join('\n');
    const summaryResult = await new LlmService(llmProvider).completeWithRetry({
      model,
      messages: [
        {
          role: 'system',
          content: 'Summarize this conversation in 2-3 sentences for future context. Be concise and factual.',
        },
        { role: 'user', content: transcript },
      ],
      maxTokens: 200,
    });
    await this.memoryService.updateSummary(conversationId, summaryResult.content);
  }
}
