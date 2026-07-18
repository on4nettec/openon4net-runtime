import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LlmCompletionResult, LlmProvider, LlmStreamChunk } from '@o2n/llm-providers';
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
});
