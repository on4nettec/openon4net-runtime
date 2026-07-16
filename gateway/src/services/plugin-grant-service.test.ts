import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { PluginGrantService } from './plugin-grant-service.js';

describe('PluginGrantService', () => {
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

  it('grants, lists, and checks a plugin grant for an agent', async () => {
    const fixture = await withFixture();
    const service = new PluginGrantService(db);
    const pluginId = randomUUID(); // cross-plane id — no local plugin row exists in Runtime

    expect(await service.hasGrant(fixture.agentId, pluginId)).toBe(false);

    const grant = await service.grant(fixture.agentId, pluginId, fixture.userId);
    expect(grant.agentId).toBe(fixture.agentId);
    expect(grant.pluginId).toBe(pluginId);
    expect(grant.grantedByUserId).toBe(fixture.userId);

    expect(await service.hasGrant(fixture.agentId, pluginId)).toBe(true);

    const list = await service.listForAgent(fixture.agentId);
    expect(list).toHaveLength(1);
    expect(list[0]?.pluginId).toBe(pluginId);
  });

  it('granting the same agent+plugin twice is idempotent (re-grant, not duplicate)', async () => {
    const fixture = await withFixture();
    const service = new PluginGrantService(db);
    const pluginId = randomUUID();

    await service.grant(fixture.agentId, pluginId, fixture.userId);
    await service.grant(fixture.agentId, pluginId, fixture.userId);

    const list = await service.listForAgent(fixture.agentId);
    expect(list).toHaveLength(1);
  });

  it('revokes a grant, and revoking a non-existent grant throws NotFoundError', async () => {
    const fixture = await withFixture();
    const service = new PluginGrantService(db);
    const pluginId = randomUUID();

    await service.grant(fixture.agentId, pluginId, fixture.userId);
    await service.revoke(fixture.agentId, pluginId);
    expect(await service.hasGrant(fixture.agentId, pluginId)).toBe(false);

    await expect(service.revoke(fixture.agentId, pluginId)).rejects.toThrow();
  });

  it('cascades away when the agent is deleted (via cleanupTestFixture)', async () => {
    const fixture = await createTestFixture(db);
    const service = new PluginGrantService(db);
    const pluginId = randomUUID();
    await service.grant(fixture.agentId, pluginId, fixture.userId);

    await cleanupTestFixture(db, fixture.organizationId);

    const { rows } = await db.query('SELECT 1 FROM agent_plugin_grants WHERE agent_id = $1', [fixture.agentId]);
    expect(rows).toHaveLength(0);
  });
});
