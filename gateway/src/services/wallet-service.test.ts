import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { WalletService } from './wallet-service.js';
import { AuditService } from './audit-service.js';

describe('WalletService', () => {
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

  it('find() returns null before any wallet has been created', async () => {
    const fixture = await withFixture();
    const walletService = new WalletService(db);
    expect(await walletService.find(fixture.organizationId)).toBeNull();
  });

  it('getOrCreate() provisions a zero-balance org wallet, idempotently', async () => {
    const fixture = await withFixture();
    const walletService = new WalletService(db);

    const first = await walletService.getOrCreate(fixture.organizationId);
    expect(first.balanceCredits).toBe(0);
    expect(first.ownerType).toBe('organization');

    const second = await walletService.getOrCreate(fixture.organizationId);
    expect(second.id).toBe(first.id);
  });

  it('credit() increases the balance and logs an audit entry', async () => {
    const fixture = await withFixture();
    const walletService = new WalletService(db);

    const wallet = await walletService.credit(fixture.organizationId, 500, 'test top-up', fixture.userId);
    expect(wallet.balanceCredits).toBe(500);

    const { logs } = await new AuditService(db).list(fixture.organizationId, { limit: 50, offset: 0 });
    expect(logs.some((l) => l.actionType === 'wallet-credit')).toBe(true);
  });

  it('debit() decreases the balance and logs an audit entry', async () => {
    const fixture = await withFixture();
    const walletService = new WalletService(db);
    await walletService.credit(fixture.organizationId, 1000, 'seed', fixture.userId);

    const wallet = await walletService.debit(fixture.organizationId, 300, 'test spend');
    expect(wallet.balanceCredits).toBe(700);

    const { logs } = await new AuditService(db).list(fixture.organizationId, { limit: 50, offset: 0 });
    expect(logs.some((l) => l.actionType === 'wallet-debit')).toBe(true);
  });

  it('debit() throws when it would take the balance negative', async () => {
    const fixture = await withFixture();
    const walletService = new WalletService(db);
    await walletService.credit(fixture.organizationId, 100, 'seed', fixture.userId);

    await expect(walletService.debit(fixture.organizationId, 200, 'too much')).rejects.toThrow();

    const wallet = await walletService.find(fixture.organizationId);
    expect(wallet?.balanceCredits).toBe(100); // unchanged
  });

  it('credit()/debit() reject non-positive amounts', async () => {
    const fixture = await withFixture();
    const walletService = new WalletService(db);

    await expect(walletService.credit(fixture.organizationId, 0, 'nope', fixture.userId)).rejects.toThrow();
    await expect(walletService.debit(fixture.organizationId, -5, 'nope')).rejects.toThrow();
  });
});
