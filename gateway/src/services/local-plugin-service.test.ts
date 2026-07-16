import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { LocalPluginService } from './local-plugin-service.js';

describe('LocalPluginService (RT-077)', () => {
  let db: Db;
  const createdOrgIds: string[] = [];

  beforeAll(() => {
    db = createTestDb();
  });

  afterEach(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await cleanupTestFixture(db, id);
    }
  });

  afterAll(async () => {
    await db.end();
  });

  async function withFixture(): Promise<TestFixture> {
    const fixture = await createTestFixture(db);
    createdOrgIds.push(fixture.organizationId);
    return fixture;
  }

  it('creates, lists, and fetches a self-hosted local plugin — entirely without Marketplace', async () => {
    const fixture = await withFixture();
    const service = new LocalPluginService(db);

    const created = await service.create(
      fixture.organizationId,
      {
        name: 'My internal notifier',
        category: 'communication',
        manifest: { provider: { type: 'http', baseUrl: 'https://example.internal/hook' } },
      },
      fixture.userId,
    );
    expect(created.id).toBeTruthy();
    expect(created.category).toBe('communication');

    const list = await service.list(fixture.organizationId);
    expect(list.some((p) => p.id === created.id)).toBe(true);

    const fetched = await service.getById(fixture.organizationId, created.id);
    expect(fetched?.manifest).toEqual({ provider: { type: 'http', baseUrl: 'https://example.internal/hook' } });
  });

  it('never resolves a plugin registered under a different organization', async () => {
    const fixtureA = await withFixture();
    const fixtureB = await withFixture();
    const service = new LocalPluginService(db);

    const created = await service.create(fixtureA.organizationId, { name: 'Org A plugin', manifest: {} }, fixtureA.userId);

    expect(await service.getById(fixtureB.organizationId, created.id)).toBeNull();
    expect(await service.list(fixtureB.organizationId)).toHaveLength(0);
  });

  it('delete is org-scoped and throws NotFoundError for a plugin belonging to another org', async () => {
    const fixtureA = await withFixture();
    const fixtureB = await withFixture();
    const service = new LocalPluginService(db);

    const created = await service.create(fixtureA.organizationId, { name: 'Org A plugin', manifest: {} }, fixtureA.userId);

    await expect(service.delete(fixtureB.organizationId, created.id)).rejects.toThrow();
    await service.delete(fixtureA.organizationId, created.id);
    expect(await service.getById(fixtureA.organizationId, created.id)).toBeNull();
  });
});
