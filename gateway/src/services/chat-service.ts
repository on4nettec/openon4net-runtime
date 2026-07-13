import type { LlmCompletionResult, LlmMessage, LlmProvider } from '@o2n/llm-providers';
import type { Agent, Conversation } from '@o2n/shared';
import {
  AgentNotActiveError,
  BudgetExceededError,
  NotFoundError,
  O2NError,
  WalletInsufficientBalanceError,
  requiresApproval,
} from '@o2n/governance';
import type { Env } from '../env.js';
import { withTransaction, type Db } from '../db.js';
import type { RedisClient } from '../redis.js';
import { AgentService } from './agent-service.js';
import { AgentAccessService } from './agent-access-service.js';
import { ApprovalService } from './approval-service.js';
import { AuditService } from './audit-service.js';
import { MemoryService, AUTO_SUMMARY_EVERY_N_MESSAGES } from './memory-service.js';
import { UserService } from './user-service.js';
import { WalletService } from './wallet-service.js';
import { LlmService } from './llm-service.js';
import type { ProviderConfigService } from './provider-config-service.js';
import type { EmbeddingService } from './embedding-service.js';
import type { PolicyService } from './policy-service.js';
import { calculateCostCents, estimateCostCentsFromChars, estimatePromptCostCents } from './pricing.js';
import { llmCostCentsTotal } from '../observability/metrics.js';

/** A chat-cost/policy approval that sits unresolved this long auto-expires (services/approval-expiry-scheduler.ts) — a stale request shouldn't silently execute if approved days later against now-stale context. */
const APPROVAL_EXPIRY_MS = 24 * 60 * 60 * 1000;

export interface ChatParams {
  organizationId: string;
  /** null for system-initiated turns (the scheduler, see services/scheduler.ts) — no human user to attribute. */
  userId: string | null;
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
  private agentAccessService: AgentAccessService;
  private userService: UserService;

  constructor(
    private db: Db,
    private redis: RedisClient,
    private providerConfigService: ProviderConfigService,
    private env: Env,
    private embeddingService: EmbeddingService,
    private policyService: PolicyService,
  ) {
    this.agentService = new AgentService(db);
    this.memoryService = new MemoryService(db, redis, env.SHORT_MEMORY_TTL_SECONDS, embeddingService);
    this.agentAccessService = new AgentAccessService(db);
    this.userService = new UserService(db);
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

    // RT-024: null userId is the scheduler (system-initiated, see
    // services/scheduler.ts) — always allowed, there's no human to gate.
    // Role is re-fetched fresh from the DB rather than trusted from a JWT
    // claim, since this also runs for the approvals.ts re-execution path
    // where the acting "user" (the original requester) may differ from
    // whoever is currently authenticated (the approver).
    if (params.userId) {
      const user = await this.userService.findById(params.userId);
      if (user && user.role !== 'admin') {
        const hasAccess = await this.agentAccessService.hasAccess(agent.id, params.userId);
        if (!hasAccess) throw new NotFoundError('Agent', agent.id);
      }
    }

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

    const estimatedCostCents = estimatePromptCostCents(model, params.message.length, providerName);

    // Budget gate 3: org-level wallet, if one has been initialized (see
    // wallet-service.ts) -> hard stop, same as gate 1. Not skippable on
    // approval-resume: a human approving an over-threshold *policy* concern
    // doesn't override an empty wallet, that's a separate hard constraint.
    const wallet = await new WalletService(this.db).find(params.organizationId);
    if (wallet && wallet.balanceCredits < estimatedCostCents) {
      throw new WalletInsufficientBalanceError(params.organizationId, wallet.balanceCredits);
    }

    // Budget gate 2: this specific request's estimated cost exceeds the
    // approval threshold -> human-in-the-loop (build pack §4.3), not an
    // error. Additive with org-configured ABAC policies (RT-008) - either
    // one triggering is enough, neither replaces the other.
    if (!skipApprovalGate) {
      const envThresholdHit = requiresApproval(estimatedCostCents, this.env.APPROVAL_THRESHOLD_CENTS);
      const policyResult = await this.policyService.evaluate(params.organizationId, { estimatedCostCents });
      if (envThresholdHit || policyResult.requiresApproval) {
        const approvalId = await this.enqueueApproval(params, agent.id, estimatedCostCents, policyResult.matchedPolicyNames);
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
    userId: string | null,
    agentId: string,
    traceId: string,
    providerName: string,
    result: { content: string; model: string; costCents: number; tokens: number },
  ): Promise<void> {
    await withTransaction(this.db, async (client) => {
      await new MemoryService(client, this.redis, this.env.SHORT_MEMORY_TTL_SECONDS, this.embeddingService).appendMessage(conversationId, {
        role: 'agent',
        content: result.content,
        model: result.model,
        costCents: result.costCents,
        tokens: result.tokens,
      });
      await new AgentService(client).addUsedBudget(organizationId, agentId, result.costCents);
      // Opt-in: only debit if this org already has a wallet row (see budget
      // gate 3 in prepare()) — a chat turn must never auto-provision one.
      if (result.costCents > 0) {
        const walletService = new WalletService(client);
        const wallet = await walletService.find(organizationId);
        if (wallet) await walletService.debit(organizationId, result.costCents, `agent-chat:${traceId}`);
      }
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

  private async enqueueApproval(
    params: ChatParams,
    agentId: string,
    estimatedCostCents: number,
    matchedPolicyNames: string[] = [],
  ): Promise<string> {
    const reason =
      matchedPolicyNames.length > 0
        ? `Matched policy: ${matchedPolicyNames.join(', ')} (estimated cost ${estimatedCostCents} cents)`
        : `Estimated cost ${estimatedCostCents} cents exceeds threshold ${this.env.APPROVAL_THRESHOLD_CENTS} cents`;
    return withTransaction(this.db, async (client) => {
      const entry = await new ApprovalService(client).create(params.organizationId, {
        agentId,
        actionData: {
          traceId: params.traceId,
          message: params.message,
          conversationId: params.conversationId ?? null,
          userId: params.userId,
          estimatedCostCents,
          matchedPolicyNames,
        },
        reason,
        expiresAt: new Date(Date.now() + APPROVAL_EXPIRY_MS),
      });
      await new AuditService(client).logAction({
        organizationId: params.organizationId,
        agentId,
        userId: params.userId,
        actionType: 'agent-chat',
        actionData: { traceId: params.traceId, estimatedCostCents },
        status: 'pending',
        approvalStatus: 'pending',
      });
      return entry.id;
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
