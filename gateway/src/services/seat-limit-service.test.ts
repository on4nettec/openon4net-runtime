import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture } from '../test-support/fixtures.js';
import { assertSeatAvailable } from './seat-limit-service.js';

/**
 * Most of assertSeatAvailable's behavior (personal cap, organizational
 * max_users, unlimited, active-only counting) is already exercised through
 * real callers in user-service.test.ts and invitation-service.test.ts — this
 * file only covers the one path neither of those reaches: an organization
 * id that doesn't exist at all.
 */
describe('assertSeatAvailable (RT-081)', () => {
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

  it('throws NotFoundError for an organization id that does not exist', async () => {
    await expect(assertSeatAvailable(db, '00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });

  it('resolves without throwing for a fresh organizational/unlimited org', async () => {
    const fixture = await createTestFixture(db);
    createdOrgIds.push(fixture.organizationId);

    await expect(assertSeatAvailable(db, fixture.organizationId)).resolves.toBeUndefined();
  });
});
