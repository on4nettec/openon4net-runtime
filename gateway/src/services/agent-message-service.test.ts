import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentCreateSchema } from '@o2n/shared';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { AgentService } from './agent-service.js';
import { AgentMessageService } from './agent-message-service.js';

describe('AgentMessageService', () => {
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

  it('send() creates a pending message visible via listForAgent', async () => {
    const fixture = await withFixture();
    const agentService = new AgentService(db);
    const messageService = new AgentMessageService(db);

    const recipient = await agentService.create(
      fixture.organizationId,
      AgentCreateSchema.parse({ name: 'Recipient', role: 'tester', workspaceId: fixture.workspaceId }),
    );

    const message = await messageService.send(fixture.organizationId, recipient.id, 'hello', fixture.agentId);
    expect(message.status).toBe('pending');
    expect(message.fromAgentId).toBe(fixture.agentId);

    const inbox = await messageService.listForAgent(fixture.organizationId, recipient.id);
    expect(inbox.some((m) => m.id === message.id)).toBe(true);
  });

  it('markDelivered flips status and sets deliveredAt', async () => {
    const fixture = await withFixture();
    const messageService = new AgentMessageService(db);

    const message = await messageService.send(fixture.organizationId, fixture.agentId, 'hi');
    await messageService.markDelivered(message.id);

    const inbox = await messageService.listForAgent(fixture.organizationId, fixture.agentId);
    const delivered = inbox.find((m) => m.id === message.id);
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.deliveredAt).not.toBeNull();
  });

  it('markFailed flips status to failed', async () => {
    const fixture = await withFixture();
    const messageService = new AgentMessageService(db);

    const message = await messageService.send(fixture.organizationId, fixture.agentId, 'hi');
    await messageService.markFailed(message.id);

    const inbox = await messageService.listForAgent(fixture.organizationId, fixture.agentId);
    expect(inbox.find((m) => m.id === message.id)?.status).toBe('failed');
  });

  it('listPending only returns pending messages', async () => {
    const fixture = await withFixture();
    const messageService = new AgentMessageService(db);

    const pendingMsg = await messageService.send(fixture.organizationId, fixture.agentId, 'still pending');
    const deliveredMsg = await messageService.send(fixture.organizationId, fixture.agentId, 'already delivered');
    await messageService.markDelivered(deliveredMsg.id);

    const pending = await messageService.listPending(1000);
    const ids = pending.map((m) => m.id);
    expect(ids).toContain(pendingMsg.id);
    expect(ids).not.toContain(deliveredMsg.id);
  });
});
