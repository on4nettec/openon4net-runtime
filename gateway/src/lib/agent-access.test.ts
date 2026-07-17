import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { assertAgentAccessFeatureEnabled } from './agent-access.js';

describe('assertAgentAccessFeatureEnabled (RT-082)', () => {
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

  it('resolves for a fresh organizational (default) org', async () => {
    const fixture = await withFixture();
    await expect(assertAgentAccessFeatureEnabled(db, fixture.organizationId)).resolves.toBeUndefined();
  });

  it('rejects a personal-activation org', async () => {
    const fixture = await withFixture();
    await db.query(`UPDATE organizations SET activation_type = 'personal' WHERE id = $1`, [fixture.organizationId]);

    await expect(assertAgentAccessFeatureEnabled(db, fixture.organizationId)).rejects.toThrow(
      /not available for personal activations/,
    );
  });

  it('resolves again once the org is switched back to organizational', async () => {
    const fixture = await withFixture();
    await db.query(`UPDATE organizations SET activation_type = 'personal' WHERE id = $1`, [fixture.organizationId]);
    await db.query(`UPDATE organizations SET activation_type = 'organizational' WHERE id = $1`, [fixture.organizationId]);

    await expect(assertAgentAccessFeatureEnabled(db, fixture.organizationId)).resolves.toBeUndefined();
  });
});
