import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { ApprovalService } from './approval-service.js';

describe('ApprovalService', () => {
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

  it('create() is a generic entry point, not tied to chat — shows up in listPending', async () => {
    const fixture = await withFixture();
    const approvalService = new ApprovalService(db);

    const entry = await approvalService.create(fixture.organizationId, {
      agentId: fixture.agentId,
      actionData: { kind: 'manual-test' },
      reason: 'because a test said so',
    });
    expect(entry.status).toBe('pending');

    const pending = await approvalService.listPending(fixture.organizationId);
    expect(pending.some((e) => e.id === entry.id)).toBe(true);
  });

  it('create() without expiresAt never gets swept by expireStale()', async () => {
    const fixture = await withFixture();
    const approvalService = new ApprovalService(db);

    const entry = await approvalService.create(fixture.organizationId, { actionData: { kind: 'no-expiry' } });
    await approvalService.expireStale();

    const refreshed = await approvalService.getPendingById(fixture.organizationId, entry.id);
    expect(refreshed.status).toBe('pending');
  });

  it('expireStale() marks past-due pending entries expired and leaves future ones alone', async () => {
    const fixture = await withFixture();
    const approvalService = new ApprovalService(db);

    const past = await approvalService.create(fixture.organizationId, {
      actionData: { kind: 'past' },
      expiresAt: new Date(Date.now() - 60_000),
    });
    const future = await approvalService.create(fixture.organizationId, {
      actionData: { kind: 'future' },
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    const touched = await approvalService.expireStale();
    expect(touched).toBeGreaterThanOrEqual(1);

    const { rows: pastRows } = await db.query<{ status: string }>(`SELECT status FROM approval_queue WHERE id = $1`, [past.id]);
    expect(pastRows[0]?.status).toBe('expired');

    const stillPending = await approvalService.getPendingById(fixture.organizationId, future.id);
    expect(stillPending.status).toBe('pending');
  });
});
