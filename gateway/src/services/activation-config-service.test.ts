import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestEnv } from '../test-support/env.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { ActivationConfigService } from './activation-config-service.js';

/**
 * RT-092 — activation_config is a deployment-wide singleton (id always 1),
 * unlike llm_configs/sso_configs's per-organization rows — every test here
 * clears it explicitly, since it isn't scoped to (and doesn't get cleaned
 * up by) any one org's fixture.
 */
describe('ActivationConfigService (RT-092)', () => {
  let db: Db;
  const env = createTestEnv();
  const createdOrgIds: string[] = [];

  beforeAll(() => {
    db = createTestDb();
  });

  afterEach(async () => {
    await db.query(`DELETE FROM activation_config WHERE id = 1`);
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

  it('getActivationKey() returns null before any key has been configured', async () => {
    const service = new ActivationConfigService(db, env);
    expect(await service.getActivationKey()).toBeNull();
  });

  it('setActivationKey() stores it encrypted, and getActivationKey() decrypts back the exact plaintext', async () => {
    const fixture = await withFixture();
    const service = new ActivationConfigService(db, env);

    await service.setActivationKey('o2n_cp_real-looking-activation-code', fixture.userId);

    const { rows } = await db.query<{ activation_key_encrypted: Buffer }>(
      `SELECT activation_key_encrypted FROM activation_config WHERE id = 1`,
    );
    expect(rows[0]?.activation_key_encrypted.toString('utf-8')).not.toContain('o2n_cp_real-looking-activation-code');

    expect(await service.getActivationKey()).toBe('o2n_cp_real-looking-activation-code');
  });

  it('setActivationKey() called twice overwrites the previous key (singleton, not a second row)', async () => {
    const fixture = await withFixture();
    const service = new ActivationConfigService(db, env);

    await service.setActivationKey('first-code', fixture.userId);
    await service.setActivationKey('second-code', fixture.userId);

    const { rows } = await db.query(`SELECT count(*)::int AS count FROM activation_config`);
    expect(rows[0]?.count).toBe(1);
    expect(await service.getActivationKey()).toBe('second-code');
  });
});
