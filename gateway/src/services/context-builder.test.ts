import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { RedisClient } from '../redis.js';
import { createRedis } from '../redis.js';
import { createTestDb } from '../test-support/db.js';
import { createTestEnv } from '../test-support/env.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { AgentService } from './agent-service.js';
import { EmbeddingService } from './embedding-service.js';
import { LocalPluginService } from './local-plugin-service.js';
import { MemoryService } from './memory-service.js';
import { PluginGrantService } from './plugin-grant-service.js';
import { SkillGrantService } from './skill-grant-service.js';
import { SkillService } from './skill-service.js';
import { ContextBuilder } from './context-builder.js';

describe('ContextBuilder (RT-031)', () => {
  let db: Db;
  let redis: RedisClient;
  let memoryService: MemoryService;
  let contextBuilder: ContextBuilder;
  const createdOrgIds: string[] = [];
  const env = createTestEnv();

  beforeAll(() => {
    db = createTestDb();
    redis = createRedis(env.REDIS_URL);
    // No EMBEDDING_MODEL in the test env -> disabled, searchMessagesSemantic
    // falls back to its ILIKE path (memory-service.ts) — real behavior, not
    // a mock, just without a live embeddings provider.
    memoryService = new MemoryService(db, redis, env.SHORT_MEMORY_TTL_SECONDS, new EmbeddingService(env));
    contextBuilder = new ContextBuilder(db, memoryService);
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
    return fixture;
  }

  it('builds identity/workspace/language layers from real rows', async () => {
    const fixture = await withFixture();
    const agent = await new AgentService(db).getById(fixture.organizationId, fixture.agentId);
    const conversation = await memoryService.getOrCreateConversation(fixture.agentId, fixture.userId);

    const context = await contextBuilder.build({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      agent,
      conversation,
      message: 'hello',
      traceId: 'trace-1',
    });

    expect(context.identity).toEqual({ agentId: agent.id, name: agent.name, role: agent.role });
    expect(context.task).toEqual({ message: 'hello', conversationId: conversation.id });
    expect(context.workspace.workspaceName).toBeTruthy();
    expect(context.workspace.organizationName).toBeTruthy();
    // The fixture's user has no language set -> falls back to the org's default.
    expect(context.language).toBe('en');
    expect(context.trace).toEqual({ traceId: 'trace-1' });
    expect(context.permissions.budgetRemainingCents).toBe(agent.monthlyBudgetCents - agent.usedBudgetCents);
  });

  it('resolves granted skill and local plugin names into the tools layer', async () => {
    const fixture = await withFixture();
    const agent = await new AgentService(db).getById(fixture.organizationId, fixture.agentId);
    const conversation = await memoryService.getOrCreateConversation(fixture.agentId, fixture.userId);

    const skill = await new SkillService(db).create(fixture.organizationId, {
      name: 'Send Weekly Report',
      definition: { trigger: { type: 'manual' }, steps: [] },
    });
    await new SkillGrantService(db).grant(fixture.agentId, skill.id, fixture.userId);

    const plugin = await new LocalPluginService(db).create(
      fixture.organizationId,
      { name: 'Internal CRM Connector', manifest: {} },
      fixture.userId,
    );
    await new PluginGrantService(db).grant(fixture.agentId, plugin.id, fixture.userId);

    // A cross-plane (marketplace-installed) grant with no local_plugins row —
    // same situation plugin-grant-service.test.ts documents. Deliberately
    // NOT resolvable to a name from Runtime alone; must be silently
    // omitted, not thrown as an error.
    await new PluginGrantService(db).grant(fixture.agentId, randomUUID(), fixture.userId);

    const context = await contextBuilder.build({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      agent,
      conversation,
      message: 'what can you do?',
      traceId: 'trace-2',
    });

    expect(context.tools.skills).toEqual(['Send Weekly Report']);
    expect(context.tools.plugins).toEqual(['Internal CRM Connector']);
  });

  it('omits the relevant-memory layer for short conversations, and includes it once the recent-message window is exceeded', async () => {
    const fixture = await withFixture();
    const agent = await new AgentService(db).getById(fixture.organizationId, fixture.agentId);
    const conversation = await memoryService.getOrCreateConversation(fixture.agentId, fixture.userId);

    const shortContext = await contextBuilder.build({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      agent,
      conversation,
      message: 'what is our refund policy?',
      traceId: 'trace-3',
    });
    expect(shortContext.memory.relevant).toEqual([]);

    for (let i = 0; i < 12; i++) {
      await memoryService.appendMessage(conversation.id, { role: i % 2 === 0 ? 'user' : 'agent', content: `filler message ${i}` });
    }
    await memoryService.appendMessage(conversation.id, { role: 'user', content: 'our refund policy is 30 days' });

    const updatedConversation = await memoryService.getConversationById(conversation.id);
    const longContext = await contextBuilder.build({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      agent,
      conversation: updatedConversation,
      message: 'refund policy',
      traceId: 'trace-4',
    });
    expect(longContext.memory.relevant.length).toBeGreaterThan(0);
  });

  it("falls back to the user's own language when set, over the organization's", async () => {
    const fixture = await withFixture();
    const agent = await new AgentService(db).getById(fixture.organizationId, fixture.agentId);
    const conversation = await memoryService.getOrCreateConversation(fixture.agentId, fixture.userId);
    await db.query(`UPDATE users SET language = 'fa' WHERE id = $1`, [fixture.userId]);

    const context = await contextBuilder.build({
      organizationId: fixture.organizationId,
      userId: fixture.userId,
      agent,
      conversation,
      message: 'hello',
      traceId: 'trace-5',
    });

    expect(context.language).toBe('fa');
  });
});
