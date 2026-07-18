import type { LlmCompletionResult, LlmMessage, LlmProvider, LlmToolDefinition } from '@o2n/llm-providers';
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
import { ContextBuilder } from './context-builder.js';
import { buildSystemPrompt } from './prompt-builder.js';
import { WalletService } from './wallet-service.js';
import { LlmService } from './llm-service.js';
import type { ProviderConfigService } from './provider-config-service.js';
import type { EmbeddingService } from './embedding-service.js';
import type { PolicyService } from './policy-service.js';
import { calculateCostCents, estimateCostCentsFromChars, estimatePromptCostCents } from './pricing.js';
import { llmCostCentsTotal } from '../observability/metrics.js';
import { buildAvailableTools, buildSkillTools, buildSkillPackageTools, toolIdForFunctionName } from './agentic-tools.js';
import { executeTool } from './tool-dispatcher.js';
import { executeSkill } from './skill-executor.js';
import { SkillService } from './skill-service.js';
import { SkillGrantService } from './skill-grant-service.js';
import { AgentMessageService } from './agent-message-service.js';
import { SkillPackageService } from './skill-package-service.js';

/** RT-085 — a chat turn's agentic loop never makes more than this many tool-decision round-trips; a model stuck re-calling tools forever must not hang the turn or run up unbounded cost. */
const MAX_TOOL_ITERATIONS = 5;

interface ToolLogEntry {
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
  /** RT-086 — set when this call was executed by another agent (this one lacked the skill grant) rather than the calling agent itself. */
  delegatedTo?: string;
}

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
  /**
   * RT-085 — the acting user's resolved RBAC permissions (request.auth.permissions),
   * used to decide which tools (if any) the model is allowed to call this
   * turn — see agentic-tools.ts's buildAvailableTools(). Omitted (not `[]`)
   * for every system/scheduler/webhook/workflow-initiated call site: tool
   * calling is deliberately scoped to interactive human chat only for now,
   * since there's no human accountable for an autonomously-triggered call.
   */
  userPermissions?: string[];
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
  // RT-084 — a reasoning-trace chunk, distinct from the answer itself; the
  // frontend renders these separately (see web/app/agents/[id]/chat).
  | { type: 'reasoning'; delta: string }
  // RT-085 — the model decided to call a tool instead of answering yet.
  | { type: 'tool_call'; name: string; arguments: Record<string, unknown> }
  // RT-086 — delegatedTo is set when another agent (not this one) actually ran the skill.
  | { type: 'tool_result'; name: string; result?: unknown; error?: string; delegatedTo?: string }
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
  /** RT-085/RT-086/RT-087 — undefined only when the acting user has none of the gated tool permissions AND the org has no active Skills AND this agent has no granted skill packages; see agentic-tools.ts. */
  tools?: LlmToolDefinition[];
  /** RT-086 — resolves a tool call's function name back to a Skill id; only Skill-backed tools appear here (the two RT-085 hardcoded tools use toolIdForFunctionName() instead). */
  skillNameToId: Map<string, string>;
  /** RT-087 — resolves a tool call's function name back to a granted skill-package id (agentskills.io "read" tools). */
  packageNameToId: Map<string, string>;
}

type PrepareOutcome = { kind: 'ready'; prepared: PreparedChat } | { kind: 'requires_approval'; approvalId: string };

function toLlmRole(role: 'user' | 'agent' | 'system' | 'tool' | 'thought'): 'user' | 'assistant' | 'system' | null {
  if (role === 'agent') return 'assistant';
  if (role === 'tool') return null; // Sprint 0 has no tool-call history to replay
  if (role === 'thought') return null; // RT-084 — a reasoning trace is not a prior conversation turn
  return role;
}

export class ChatService {
  private agentService: AgentService;
  private memoryService: MemoryService;
  private agentAccessService: AgentAccessService;
  private userService: UserService;
  private contextBuilder: ContextBuilder;
  private skillService: SkillService;
  private skillGrantService: SkillGrantService;
  private agentMessageService: AgentMessageService;
  private skillPackageService: SkillPackageService;

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
    this.contextBuilder = new ContextBuilder(db, this.memoryService);
    this.skillService = new SkillService(db);
    this.skillGrantService = new SkillGrantService(db);
    this.agentMessageService = new AgentMessageService(db);
    this.skillPackageService = new SkillPackageService(db);
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
    // RT-031 — context is assembled as a formal artifact (identity/task/
    // workspace/memory/tools/permissions/language/trace, see
    // context-builder.ts) then compressed into a single system message.
    const context = await this.contextBuilder.build({
      organizationId: params.organizationId,
      userId: params.userId,
      agent,
      conversation,
      message: params.message,
      traceId: params.traceId,
    });
    const systemPrompt = buildSystemPrompt(context);
    const llmMessages: LlmMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history
        .map((m): LlmMessage | null => {
          const role = toLlmRole(m.role);
          return role ? { role, content: m.content } : null;
        })
        .filter((m): m is LlmMessage => m !== null),
    ];
    const promptChars = llmMessages.reduce((sum, m) => sum + m.content.length, 0);

    // RT-085: two hardcoded tools, gated by the acting user's own RBAC
    // permissions. RT-086: every active Skill in the org, regardless of
    // whether *this* agent has it granted — the grant check (and automatic
    // delegation when it's missing) happens at execution time, not here.
    // RT-087: skill packages (agentskills.io) already granted to *this*
    // agent specifically — no delegation concept for pure documentation, so
    // gating at advertisement time (not execution time) is simpler and
    // equally correct.
    const hardcodedTools = buildAvailableTools(params.userPermissions ?? []) ?? [];
    const orgSkills = await this.skillService.list(params.organizationId);
    const { tools: skillTools, nameToSkillId: skillNameToId } = buildSkillTools(orgSkills);
    const grantedPackages = await this.skillPackageService.listGrantedForAgent(params.organizationId, params.agentId);
    const { tools: packageTools, nameToPackageId: packageNameToId } = buildSkillPackageTools(grantedPackages);
    const allTools = [...hardcodedTools, ...skillTools, ...packageTools];

    return {
      kind: 'ready',
      prepared: {
        agent,
        conversation,
        llmMessages,
        model,
        promptChars,
        llmProvider,
        providerName,
        skillNameToId,
        packageNameToId,
        ...(allTools.length > 0 ? { tools: allTools } : {}),
      },
    };
  }

  private async persistTurn(
    conversationId: string,
    organizationId: string,
    userId: string | null,
    agentId: string,
    traceId: string,
    providerName: string,
    result: { content: string; model: string; costCents: number; tokens: number; reasoning?: string },
    toolLog: ToolLogEntry[] = [],
  ): Promise<void> {
    await withTransaction(this.db, async (client) => {
      const memoryService = new MemoryService(client, this.redis, this.env.SHORT_MEMORY_TTL_SECONDS, this.embeddingService);
      // RT-085 — written first: each tool call the model made this turn,
      // in the order they happened, before the final answer they led to.
      // 'tool' rows are never replayed as prior-turn LLM history
      // (toLlmRole() returns null for them) — same treatment as 'thought'.
      for (const entry of toolLog) {
        const delegationSuffix = entry.delegatedTo ? ` (delegated to ${entry.delegatedTo})` : '';
        await memoryService.appendMessage(conversationId, {
          role: 'tool',
          content: (entry.error ? `${entry.name} failed: ${entry.error}` : `Called ${entry.name}`) + delegationSuffix,
          metadata: {
            name: entry.name,
            arguments: entry.arguments,
            ...(entry.error ? { error: entry.error } : { result: entry.result }),
            ...(entry.delegatedTo ? { delegatedTo: entry.delegatedTo } : {}),
          },
        });
      }
      // RT-084 — written next so it lands immediately before the agent's
      // answer in the conversation's created_at ordering, letting the
      // frontend pair a 'thought' row with the 'agent' row that follows it.
      if (result.reasoning) {
        await memoryService.appendMessage(conversationId, { role: 'thought', content: result.reasoning });
      }
      await memoryService.appendMessage(conversationId, {
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
    tools?: LlmToolDefinition[],
  ): Promise<LlmCompletionResult> {
    try {
      return await new LlmService(llmProvider).completeWithRetry({ model, messages, ...(tools ? { tools } : {}) });
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

  /**
   * RT-085 — the ReAct loop: call the model with the available tools
   * attached, and if it chooses to call one (or more) instead of answering,
   * execute each and feed the result back for another round — up to
   * MAX_TOOL_ITERATIONS. Yields `tool_call`/`tool_result` events as they
   * happen (chatStream() forwards these to the client immediately;
   * chat()/the non-streaming path just drains and discards them) and
   * returns the final `LlmCompletionResult` plus the full tool log for
   * persistence. `llmMessages` is mutated with a local copy only — the
   * assistant/tool round-trip messages exist for this turn's provider calls
   * alone, never written back into `prepared.llmMessages` or replayed as
   * conversation history in a future turn (see toLlmRole()).
   *
   * A tool call gated by an org policy (RT-008/RT-056, same
   * checkPolicyGate reasoning as routes/tools.ts's direct HTTP path) is
   * deliberately NOT executed and NOT queued for later approval — there is
   * no async "resume this chat turn after a human approves" mechanism yet.
   * Instead the model is told the action requires manual approval, so it
   * can say so to the user rather than the turn silently bypassing the
   * same gate a direct API call would hit.
   */
  private async *runToolLoop(
    llmMessages: LlmMessage[],
    model: string,
    llmProvider: LlmProvider,
    tools: LlmToolDefinition[] | undefined,
    params: ChatParams,
    agentId: string,
    skillNameToId: Map<string, string>,
    packageNameToId: Map<string, string>,
  ): AsyncGenerator<
    ChatStreamEvent,
    { result: LlmCompletionResult; toolLog: ToolLogEntry[]; totalInputTokens: number; totalOutputTokens: number },
    void
  > {
    const toolLog: ToolLogEntry[] = [];
    // Every callModel() round this turn makes costs real tokens — a
    // multi-round tool loop must be billed/audited for all of them, not
    // just whichever round happens to produce the final answer.
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    if (!tools) {
      const result = await this.callModel(llmMessages, model, llmProvider, params, agentId);
      return { result, toolLog, totalInputTokens: result.inputTokens, totalOutputTokens: result.outputTokens };
    }

    const messages = [...llmMessages];
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const result = await this.callModel(messages, model, llmProvider, params, agentId, tools);
      totalInputTokens += result.inputTokens;
      totalOutputTokens += result.outputTokens;
      if (!result.toolCalls?.length) {
        return { result, toolLog, totalInputTokens, totalOutputTokens };
      }

      messages.push({ role: 'assistant', content: result.content, toolCalls: result.toolCalls });

      for (const call of result.toolCalls) {
        const toolId = toolIdForFunctionName(call.name);
        const skillId = skillNameToId.get(call.name);
        const packageId = packageNameToId.get(call.name);
        let entry: ToolLogEntry;

        if (toolId) {
          const actionType = toolId === 'telegram-send' ? 'tool-telegram-send' : 'tool-webhook-send';
          const policyResult = await this.policyService.evaluate(params.organizationId, {
            estimatedCostCents: 0,
            actionType,
          });
          if (policyResult.requiresApproval) {
            entry = {
              name: call.name,
              arguments: call.arguments,
              error: 'This action requires manual approval and was not executed automatically from chat.',
            };
          } else {
            try {
              const toolResult = await executeTool({ id: call.id, type: 'tool', tool: toolId, params: call.arguments }, this.env);
              entry = { name: call.name, arguments: call.arguments, result: toolResult };
            } catch (err) {
              entry = { name: call.name, arguments: call.arguments, error: err instanceof O2NError ? err.message : 'Tool execution failed' };
            }
          }
        } else if (skillId) {
          entry = await this.runSkillCall(params.organizationId, agentId, skillId, call.name, call.arguments);
        } else if (packageId) {
          entry = await this.runSkillPackageRead(params.organizationId, packageId, call.name, call.arguments);
        } else {
          entry = { name: call.name, arguments: call.arguments, error: `Unknown tool: ${call.name}` };
        }

        toolLog.push(entry);
        yield { type: 'tool_call', name: entry.name, arguments: entry.arguments };
        yield entry.error
          ? { type: 'tool_result', name: entry.name, error: entry.error, ...(entry.delegatedTo ? { delegatedTo: entry.delegatedTo } : {}) }
          : { type: 'tool_result', name: entry.name, result: entry.result, ...(entry.delegatedTo ? { delegatedTo: entry.delegatedTo } : {}) };
        messages.push({ role: 'tool', content: JSON.stringify(entry.error ? { error: entry.error } : entry.result), toolCallId: call.id });
      }
    }

    // Safety cap hit — one last call with tools withheld so the model is
    // forced to answer in plain text instead of looping forever.
    const finalResult = await this.callModel(messages, model, llmProvider, params, agentId);
    totalInputTokens += finalResult.inputTokens;
    totalOutputTokens += finalResult.outputTokens;
    return { result: finalResult, toolLog, totalInputTokens, totalOutputTokens };
  }

  /**
   * RT-086 — runs a Skill the model asked for, executing it on this agent
   * directly if it has the grant, or automatically delegating to another
   * agent in the org that does. Delegation is recorded as a real
   * `agent_messages` row (from this agent, to the delegate) so it shows up
   * in the delegate's inbox and the audit trail — even though the actual
   * work happens synchronously here (not via the scheduler's async
   * fire-and-forget chat() delivery), since the caller needs the result
   * back to continue this same turn.
   */
  private async runSkillCall(
    organizationId: string,
    callingAgentId: string,
    skillId: string,
    callName: string,
    args: Record<string, unknown>,
  ): Promise<ToolLogEntry> {
    const hasGrant = await this.skillGrantService.hasGrant(callingAgentId, skillId);
    if (hasGrant) {
      try {
        const result = await executeSkill(this.db, this.env, organizationId, callingAgentId, skillId, args);
        return { name: callName, arguments: args, result };
      } catch (err) {
        return { name: callName, arguments: args, error: err instanceof O2NError ? err.message : 'Skill execution failed' };
      }
    }

    const delegate = await this.skillGrantService.findGrantedAgent(organizationId, skillId, callingAgentId);
    if (!delegate) {
      return { name: callName, arguments: args, error: `No agent in this organization has the "${callName}" skill granted.` };
    }

    const message = await this.agentMessageService.send(
      organizationId,
      delegate.agentId,
      `Delegated skill execution: "${callName}" (this agent isn't granted it; ${delegate.agentName} is).`,
      callingAgentId,
    );
    try {
      const result = await executeSkill(this.db, this.env, organizationId, delegate.agentId, skillId, args);
      await this.agentMessageService.markDelivered(message.id);
      return { name: callName, arguments: args, result, delegatedTo: delegate.agentName };
    } catch (err) {
      await this.agentMessageService.markFailed(message.id);
      return {
        name: callName,
        arguments: args,
        error: err instanceof O2NError ? err.message : 'Skill execution failed',
        delegatedTo: delegate.agentName,
      };
    }
  }

  /**
   * RT-087 — Agent Skills open standard (agentskills.io), v1 instructions-
   * only scope: "activating" a skill package has no side effects and
   * nothing to delegate (it's pure documentation) — this just returns the
   * markdown instructions the model asked to read. Visibility was already
   * gated by grant at advertisement time (buildSkillPackageTools()), so no
   * grant check is repeated here.
   */
  private async runSkillPackageRead(
    organizationId: string,
    skillPackageId: string,
    callName: string,
    args: Record<string, unknown>,
  ): Promise<ToolLogEntry> {
    try {
      const pkg = await this.skillPackageService.getById(organizationId, skillPackageId);
      return { name: callName, arguments: args, result: { instructions: pkg.instructions } };
    } catch (err) {
      return { name: callName, arguments: args, error: err instanceof O2NError ? err.message : 'Failed to read skill instructions' };
    }
  }

  async chat(params: ChatParams, skipApprovalGate = false): Promise<ChatOutcome> {
    const outcome = await this.prepare(params, skipApprovalGate);
    if (outcome.kind === 'requires_approval') return outcome;
    const { agent, conversation, llmMessages, model, llmProvider, providerName, tools, skillNameToId, packageNameToId } =
      outcome.prepared;

    // RT-085 — drain the loop's yielded tool_call/tool_result events without
    // exposing them in ChatOutcome's JSON shape (out of scope for the
    // non-streaming response for now); they're still visible afterward via
    // the persisted 'tool' conversation rows either way.
    const loop = this.runToolLoop(llmMessages, model, llmProvider, tools, params, agent.id, skillNameToId, packageNameToId);
    let step = await loop.next();
    while (!step.done) step = await loop.next();
    const { result, toolLog, totalInputTokens, totalOutputTokens } = step.value;

    const costCents = calculateCostCents(result.model, totalInputTokens, totalOutputTokens, providerName);

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
        tokens: totalInputTokens + totalOutputTokens,
        ...(result.reasoning ? { reasoning: result.reasoning } : {}),
      },
      toolLog,
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
    const { agent, conversation, llmMessages, model, promptChars, llmProvider, providerName, tools, skillNameToId, packageNameToId } =
      outcome.prepared;

    const start = Date.now();
    let full = '';
    let reasoning = '';
    let costCents: number;
    let tokens: number;
    let toolLog: ToolLogEntry[] = [];

    if (tools) {
      // RT-085 — an agent with tool permissions granted: the loop's
      // tool-decision rounds are non-streaming complete() calls (executing
      // a tool requires the FULL call, not partial streamed JSON
      // arguments), forwarded live as tool_call/tool_result events. Once
      // the model settles on a plain-text answer, that answer is already a
      // complete string from the loop's last round — emitted as one token
      // event rather than paying for a second, separately-streamed
      // provider call just to get per-token delivery of the same text.
      let result: LlmCompletionResult;
      try {
        const loopResult = yield* this.runToolLoop(llmMessages, model, llmProvider, tools, params, agent.id, skillNameToId, packageNameToId);
        result = loopResult.result;
        toolLog = loopResult.toolLog;
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
      full = result.content;
      reasoning = result.reasoning ?? '';
      if (result.reasoning) yield { type: 'reasoning', delta: result.reasoning };
      if (result.content) yield { type: 'token', delta: result.content };
      costCents = calculateCostCents(result.model, result.inputTokens, result.outputTokens, providerName);
      tokens = result.inputTokens + result.outputTokens;
    } else {
      try {
        for await (const chunk of new LlmService(llmProvider).stream({ model, messages: llmMessages })) {
          if (chunk.isReasoning) {
            reasoning += chunk.delta;
            yield { type: 'reasoning', delta: chunk.delta };
          } else {
            full += chunk.delta;
            yield { type: 'token', delta: chunk.delta };
          }
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
      costCents = estimateCostCentsFromChars(model, promptChars, full.length, providerName);
      tokens = Math.ceil((promptChars + full.length) / 4);
    }

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
        tokens,
        ...(reasoning ? { reasoning } : {}),
      },
      toolLog,
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
