import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import type { RedisClient } from '../redis.js';
import { createRedis } from '../redis.js';
import { createTestDb } from '../test-support/db.js';
import { createTestEnv } from '../test-support/env.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { EmbeddingService } from './embedding-service.js';
import { MemoryService } from './memory-service.js';

describe('MemoryService — session management (RT-022)', () => {
  let db: Db;
  let redis: RedisClient;
  let memoryService: MemoryService;
  const createdOrgIds: string[] = [];
  const env = createTestEnv();

  beforeAll(() => {
    db = createTestDb();
    redis = createRedis(env.REDIS_URL);
    memoryService = new MemoryService(db, redis, env.SHORT_MEMORY_TTL_SECONDS, new EmbeddingService(env));
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

  it('createConversation makes a distinct new session even when one already exists', async () => {
    const fixture = await withFixture();
    const first = await memoryService.getOrCreateConversation(fixture.agentId, fixture.userId);
    const second = await memoryService.createConversation(fixture.agentId, fixture.userId, 'Second session');

    expect(second.id).not.toBe(first.id);
    expect(second.title).toBe('Second session');

    const list = await memoryService.listConversations(fixture.agentId);
    expect(list.map((c) => c.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('listConversations orders most-recently-updated first', async () => {
    const fixture = await withFixture();
    const older = await memoryService.createConversation(fixture.agentId, fixture.userId, 'Older');
    const newer = await memoryService.createConversation(fixture.agentId, fixture.userId, 'Newer');
    await memoryService.appendMessage(newer.id, { role: 'user', content: 'bumps updated_at' });

    const list = await memoryService.listConversations(fixture.agentId);
    expect(list[0]?.id).toBe(newer.id);
    expect(list.some((c) => c.id === older.id)).toBe(true);
  });

  it('renameConversation updates the title, and throws NotFoundError for an unknown id', async () => {
    const fixture = await withFixture();
    const conversation = await memoryService.createConversation(fixture.agentId, fixture.userId);
    const renamed = await memoryService.renameConversation(conversation.id, 'My renamed session');
    expect(renamed.title).toBe('My renamed session');

    await expect(memoryService.renameConversation('00000000-0000-0000-0000-000000000000', 'x')).rejects.toThrow();
  });

  it('archiveConversation sets status=archived and excludes it from listConversations by default', async () => {
    const fixture = await withFixture();
    const conversation = await memoryService.createConversation(fixture.agentId, fixture.userId);
    const archived = await memoryService.archiveConversation(conversation.id);
    expect(archived.status).toBe('archived');

    const activeOnly = await memoryService.listConversations(fixture.agentId);
    expect(activeOnly.find((c) => c.id === conversation.id)).toBeUndefined();

    const includingArchived = await memoryService.listConversations(fixture.agentId, { includeArchived: true });
    expect(includingArchived.find((c) => c.id === conversation.id)).toBeDefined();
  });
});
