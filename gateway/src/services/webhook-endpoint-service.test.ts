import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { WebhookEndpointService } from './webhook-endpoint-service.js';

describe('WebhookEndpointService', () => {
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

  it('create() returns the raw token once, and never persists it in plaintext', async () => {
    const fixture = await withFixture();
    const service = new WebhookEndpointService(db);

    const { endpoint, token } = await service.create(
      fixture.organizationId,
      { name: 'My webhook', targetType: 'agent', targetId: fixture.agentId },
      fixture.userId,
    );

    expect(token).toHaveLength(64); // 32 random bytes, hex-encoded
    expect(endpoint.targetType).toBe('agent');

    const { rows } = await db.query<{ token_hash: string }>(`SELECT token_hash FROM webhook_endpoints WHERE id = $1`, [
      endpoint.id,
    ]);
    expect(rows[0]!.token_hash).not.toBe(token);
  });

  it('findByToken() resolves an active endpoint by its raw token', async () => {
    const fixture = await withFixture();
    const service = new WebhookEndpointService(db);
    const { endpoint, token } = await service.create(
      fixture.organizationId,
      { name: 'Lookup me', targetType: 'workflow', targetId: fixture.agentId },
      fixture.userId,
    );

    const found = await service.findByToken(token);
    expect(found?.id).toBe(endpoint.id);
  });

  it('findByToken() returns null for an unknown or garbage token', async () => {
    const service = new WebhookEndpointService(db);
    expect(await service.findByToken('not-a-real-token')).toBeNull();
  });

  it('delete() removes the endpoint, and it can no longer be found by token', async () => {
    const fixture = await withFixture();
    const service = new WebhookEndpointService(db);
    const { endpoint, token } = await service.create(
      fixture.organizationId,
      { name: 'Temp', targetType: 'agent', targetId: fixture.agentId },
      fixture.userId,
    );

    await service.delete(fixture.organizationId, endpoint.id);
    expect(await service.findByToken(token)).toBeNull();
  });

  it('delete() throws for an endpoint outside the organization', async () => {
    const fixture = await withFixture();
    const other = await withFixture();
    const service = new WebhookEndpointService(db);
    const { endpoint } = await service.create(
      other.organizationId,
      { name: 'Theirs', targetType: 'agent', targetId: other.agentId },
      other.userId,
    );

    await expect(service.delete(fixture.organizationId, endpoint.id)).rejects.toThrow();
  });

  it('markTriggered() sets lastTriggeredAt', async () => {
    const fixture = await withFixture();
    const service = new WebhookEndpointService(db);
    const { endpoint } = await service.create(
      fixture.organizationId,
      { name: 'Trigger me', targetType: 'agent', targetId: fixture.agentId },
      fixture.userId,
    );
    expect(endpoint.lastTriggeredAt).toBeNull();

    await service.markTriggered(endpoint.id);
    const list = await service.list(fixture.organizationId);
    expect(list.find((e) => e.id === endpoint.id)?.lastTriggeredAt).not.toBeNull();
  });
});
