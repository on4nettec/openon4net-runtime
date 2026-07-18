import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LlmCompletionRequest, LlmCompletionResult, LlmProvider, LlmStreamChunk } from '@o2n/llm-providers';
import type { Db } from '../db.js';
import type { RedisClient } from '../redis.js';
import { createRedis } from '../redis.js';
import { createTestDb } from '../test-support/db.js';
import { createTestEnv } from '../test-support/env.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { EmbeddingService } from './embedding-service.js';
import { MemoryService } from './memory-service.js';
import { PolicyService } from './policy-service.js';
import { ProviderConfigService } from './provider-config-service.js';
import { ChatService } from './chat-service.js';

/**
 * RT-084 — reasoning-trace persistence: a real ProviderConfigService talks
 * to Postgres for org-configured provider rows, which this test doesn't
 * need at all (it wants a fully deterministic fake LlmProvider instead,
 * same "inject a fake provider factory" pattern CP-012's
 * ai-gateway-service.test.ts used). Subclassing (not a plain object cast)
 * keeps this type-safe against ProviderConfigService's private fields —
 * resolve() is overridden; every other inherited method is simply never
 * called by ChatService.
 */
class FakeProviderConfigService extends ProviderConfigService {
  constructor(private fakeProvider: LlmProvider, env = createTestEnv()) {
    super({} as Db, env);
  }
  override async resolve(): Promise<{ provider: LlmProvider; model: string; providerName: string }> {
    return { provider: this.fakeProvider, model: 'fake-model', providerName: 'fake' };
  }
}

function fakeProvider(result: LlmCompletionResult, streamChunks: LlmStreamChunk[]): LlmProvider {
  return {
    name: 'fake',
    async complete(): Promise<LlmCompletionResult> {
      return result;
    },
    async *stream(): AsyncIterable<LlmStreamChunk> {
      for (const chunk of streamChunks) yield chunk;
    },
  };
}

describe('ChatService — reasoning trace persistence (RT-084)', () => {
  let db: Db;
  let redis: RedisClient;
  const createdOrgIds: string[] = [];
  const env = createTestEnv();

  beforeAll(() => {
    db = createTestDb();
    redis = createRedis(env.REDIS_URL);
  });

  afterEach(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await cleanupTestFixture(db, id);
    }
  });

  afterAll(async () => {
    redis.disconnect();
    await db.end();
  });

  async function withFixture(): Promise<TestFixture> {
    const fixture = await createTestFixture(db);
    createdOrgIds.push(fixture.organizationId);
    // createTestFixture's user defaults to role='member' (migrations/0001_core.sql),
    // which would otherwise trip RT-024's agent-access gate in prepare() —
    // irrelevant to what this suite tests, so bypass it the simple way.
    await db.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [fixture.userId]);
    return fixture;
  }

  function buildChatService(providerConfigService: ProviderConfigService): ChatService {
    const embeddingService = new EmbeddingService(env);
    const policyService = new PolicyService(db);
    return new ChatService(db, redis, providerConfigService, env, embeddingService, policyService);
  }

  it('chat() persists a preceding "thought" row when the provider returns reasoning, none when it does not', async () => {
    const fixture = await withFixture();
    const withReasoning = buildChatService(
      new FakeProviderConfigService(
        fakeProvider(
          { content: 'The answer is 4.', model: 'fake-model', inputTokens: 10, outputTokens: 5, reasoning: '2+2=4, so the answer is 4.' },
          [],
        ),
      ),
    );

    const outcome = await withReasoning.chat({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      agentId: fixture.agentId,
      message: 'what is 2+2?',
      traceId: 'trace-1',
    });
    expect(outcome.kind).toBe('success');
    if (outcome.kind !== 'success') throw new Error('expected success');

    const memoryService = new MemoryService(db, redis, env.SHORT_MEMORY_TTL_SECONDS, new EmbeddingService(env));
    const messages = await memoryService.getRecentMessages(outcome.conversationId, 10);
    const roles = messages.map((m) => m.role);
    // user -> thought -> agent, in that insertion order.
    expect(roles).toEqual(['user', 'thought', 'agent']);
    const thought = messages.find((m) => m.role === 'thought');
    expect(thought?.content).toBe('2+2=4, so the answer is 4.');

    const withoutReasoning = buildChatService(
      new FakeProviderConfigService(
        fakeProvider({ content: 'Hello!', model: 'fake-model', inputTokens: 3, outputTokens: 2 }, []),
      ),
    );
    const outcome2 = await withoutReasoning.chat({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      agentId: fixture.agentId,
      message: 'hi',
      conversationId: outcome.conversationId,
      traceId: 'trace-2',
    });
    expect(outcome2.kind).toBe('success');
    const messagesAfter = await memoryService.getRecentMessages(outcome.conversationId, 10);
    // No new 'thought' row for this second turn.
    expect(messagesAfter.filter((m) => m.role === 'thought')).toHaveLength(1);
  });

  it('chatStream() yields separate "reasoning" events and persists the accumulated trace as a "thought" row', async () => {
    const fixture = await withFixture();
    const chatService = buildChatService(
      new FakeProviderConfigService(
        fakeProvider({ content: '', model: 'fake-model', inputTokens: 0, outputTokens: 0 }, [
          { delta: 'Thinking... ', isReasoning: true },
          { delta: '2+2=4.', isReasoning: true },
          { delta: 'The answer ' },
          { delta: 'is 4.' },
        ]),
      ),
    );

    const events: { type: string; delta?: string }[] = [];
    let conversationId: string | undefined;
    for await (const event of chatService.chatStream({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      agentId: fixture.agentId,
      message: 'what is 2+2?',
      traceId: 'trace-3',
    })) {
      events.push({ type: event.type, ...(('delta' in event) ? { delta: event.delta } : {}) });
      if (event.type === 'done') conversationId = event.conversationId;
    }

    expect(events).toEqual([
      { type: 'reasoning', delta: 'Thinking... ' },
      { type: 'reasoning', delta: '2+2=4.' },
      { type: 'token', delta: 'The answer ' },
      { type: 'token', delta: 'is 4.' },
      { type: 'done' },
    ]);
    expect(conversationId).toBeDefined();

    const memoryService = new MemoryService(db, redis, env.SHORT_MEMORY_TTL_SECONDS, new EmbeddingService(env));
    const messages = await memoryService.getRecentMessages(conversationId!, 10);
    const thought = messages.find((m) => m.role === 'thought');
    expect(thought?.content).toBe('Thinking... 2+2=4.');
    const agentMessage = messages.find((m) => m.role === 'agent');
    expect(agentMessage?.content).toBe('The answer is 4.');
  });

  describe('RT-085 — agentic tool-calling loop', () => {
    /** Returns a fixed sequence of results, one per complete() call (repeating the last once exhausted), and records every request the loop sent. */
    function fakeSequencedProvider(results: LlmCompletionResult[]): LlmProvider & { calls: LlmCompletionRequest[] } {
      const calls: LlmCompletionRequest[] = [];
      let i = 0;
      return {
        name: 'fake',
        calls,
        async complete(req: LlmCompletionRequest): Promise<LlmCompletionResult> {
          calls.push(req);
          const result = results[Math.min(i, results.length - 1)]!;
          i += 1;
          return result;
        },
        async *stream(): AsyncIterable<LlmStreamChunk> {
          throw new Error('not used by these tests');
        },
      };
    }

    it('chat() executes a granted tool call end-to-end, persists a "tool" row, and returns the final answer', async () => {
      const fixture = await withFixture();
      const provider = fakeSequencedProvider([
        {
          content: '',
          model: 'fake-model',
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: [{ id: 'call_1', name: 'webhook_send', arguments: { url: 'https://postman-echo.com/post', payload: { hello: 'world' } } }],
        },
        { content: 'Done, I sent the webhook.', model: 'fake-model', inputTokens: 8, outputTokens: 6 },
      ]);
      const chatService = buildChatService(new FakeProviderConfigService(provider));

      const outcome = await chatService.chat({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        message: 'send a webhook to postman-echo',
        traceId: 'trace-tool-1',
        userPermissions: ['tools:webhook-send'],
      });

      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') throw new Error('expected success');
      expect(outcome.response).toBe('Done, I sent the webhook.');

      // The model was offered the tool on the first call.
      expect(provider.calls[0]?.tools).toEqual([
        expect.objectContaining({ name: 'webhook_send' }),
      ]);
      // Second call carries the assistant tool-call + tool-result round trip.
      expect(provider.calls[1]?.messages.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(true);
      expect(provider.calls[1]?.messages.some((m) => m.role === 'tool' && m.toolCallId === 'call_1')).toBe(true);

      const memoryService = new MemoryService(db, redis, env.SHORT_MEMORY_TTL_SECONDS, new EmbeddingService(env));
      const messages = await memoryService.getRecentMessages(outcome.conversationId, 10);
      const toolRow = messages.find((m) => m.role === 'tool');
      expect(toolRow?.content).toBe('Called webhook_send');
      expect(toolRow?.metadata).toMatchObject({ name: 'webhook_send', result: { statusCode: 200 } });
    });

    it('offers no tools at all when userPermissions is omitted — zero behavior change for agents without grants', async () => {
      const fixture = await withFixture();
      const provider = fakeSequencedProvider([{ content: 'Hi there!', model: 'fake-model', inputTokens: 3, outputTokens: 2 }]);
      const chatService = buildChatService(new FakeProviderConfigService(provider));

      const outcome = await chatService.chat({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        message: 'hi',
        traceId: 'trace-tool-2',
      });

      expect(outcome.kind).toBe('success');
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0]?.tools).toBeUndefined();
    });

    it('chatStream() forwards tool_call/tool_result events live, then the final answer as one token event', async () => {
      const fixture = await withFixture();
      const provider = fakeSequencedProvider([
        {
          content: '',
          model: 'fake-model',
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: [{ id: 'call_1', name: 'webhook_send', arguments: { url: 'https://postman-echo.com/post', payload: {} } }],
        },
        { content: 'All set.', model: 'fake-model', inputTokens: 4, outputTokens: 3 },
      ]);
      const chatService = buildChatService(new FakeProviderConfigService(provider));

      const events: { type: string }[] = [];
      for await (const event of chatService.chatStream({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        message: 'send a webhook',
        traceId: 'trace-tool-3',
        userPermissions: ['tools:webhook-send'],
      })) {
        events.push(event);
      }

      expect(events.map((e) => e.type)).toEqual(['tool_call', 'tool_result', 'token', 'done']);
      expect(events[0]).toMatchObject({ type: 'tool_call', name: 'webhook_send' });
      expect(events[1]).toMatchObject({ type: 'tool_result', name: 'webhook_send', result: { statusCode: 200 } });
      expect(events[2]).toMatchObject({ type: 'token', delta: 'All set.' });
    });

    it('a policy requiring approval blocks tool execution instead of running it, and tells the model so', async () => {
      const fixture = await withFixture();
      await new PolicyService(db).create(fixture.organizationId, 'Webhooks need approval', {
        type: 'action_type_in',
        actionTypes: ['tool-webhook-send'],
      });
      const provider = fakeSequencedProvider([
        {
          content: '',
          model: 'fake-model',
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: [{ id: 'call_1', name: 'webhook_send', arguments: { url: 'https://postman-echo.com/post', payload: {} } }],
        },
        { content: 'I could not send that without approval.', model: 'fake-model', inputTokens: 6, outputTokens: 4 },
      ]);
      const chatService = buildChatService(new FakeProviderConfigService(provider));

      const outcome = await chatService.chat({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        message: 'send a webhook',
        traceId: 'trace-tool-4',
        userPermissions: ['tools:webhook-send'],
      });

      expect(outcome.kind).toBe('success');
      // The second call's tool-result message must carry the approval-required error, not a real webhook result.
      const secondCallMessages = provider.calls[1]?.messages ?? [];
      const toolResultMessage = secondCallMessages.find((m) => m.role === 'tool');
      expect(toolResultMessage?.content).toContain('requires manual approval');
    });

    it('an unknown tool name from the model is logged as an error, not a crash', async () => {
      const fixture = await withFixture();
      const provider = fakeSequencedProvider([
        {
          content: '',
          model: 'fake-model',
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: [{ id: 'call_1', name: 'delete_the_database', arguments: {} }],
        },
        { content: "I don't have that tool.", model: 'fake-model', inputTokens: 4, outputTokens: 3 },
      ]);
      const chatService = buildChatService(new FakeProviderConfigService(provider));

      const outcome = await chatService.chat({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        message: 'do something',
        traceId: 'trace-tool-5',
        userPermissions: ['tools:webhook-send', 'tools:telegram-send'],
      });

      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') throw new Error('expected success');
      expect(outcome.response).toBe("I don't have that tool.");
      const secondCallMessages = provider.calls[1]?.messages ?? [];
      const toolResultMessage = secondCallMessages.find((m) => m.role === 'tool');
      expect(toolResultMessage?.content).toContain('Unknown tool');
    });

    it('hits MAX_TOOL_ITERATIONS and forces a final plain-text answer instead of looping forever', async () => {
      const fixture = await withFixture();
      // Always returns a tool call, never a plain answer — the loop must
      // still terminate and force a final answer instead of hanging.
      const alwaysCallsTool: LlmCompletionResult = {
        content: '',
        model: 'fake-model',
        inputTokens: 1,
        outputTokens: 1,
        toolCalls: [{ id: 'call_x', name: 'webhook_send', arguments: { url: 'https://postman-echo.com/post', payload: {} } }],
      };
      const provider = fakeSequencedProvider([alwaysCallsTool]);
      // Override the fake's behavior: the safety-cap final call is made
      // WITHOUT tools attached (see runToolLoop) — return plain content then.
      const originalComplete = provider.complete.bind(provider);
      provider.complete = async (req: LlmCompletionRequest) => {
        if (!req.tools) {
          provider.calls.push(req);
          return { content: 'Giving up on tools, here is my answer.', model: 'fake-model', inputTokens: 1, outputTokens: 1 };
        }
        return originalComplete(req);
      };

      const chatService = buildChatService(new FakeProviderConfigService(provider));
      const outcome = await chatService.chat({
        organizationId: fixture.organizationId,
        userId: fixture.userId,
        agentId: fixture.agentId,
        message: 'loop forever',
        traceId: 'trace-tool-6',
        userPermissions: ['tools:webhook-send'],
      });

      expect(outcome.kind).toBe('success');
      if (outcome.kind !== 'success') throw new Error('expected success');
      expect(outcome.response).toBe('Giving up on tools, here is my answer.');
      // 5 tool-decision rounds (MAX_TOOL_ITERATIONS) + 1 final forced round.
      expect(provider.calls).toHaveLength(6);
    });
  });
});
