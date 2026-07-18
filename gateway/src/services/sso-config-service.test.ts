import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestEnv } from '../test-support/env.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { SsoConfigService } from './sso-config-service.js';

describe('SsoConfigService', () => {
  let db: Db;
  const env = createTestEnv();
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

  it('getEffectiveConfig() returns null before any config has been set', async () => {
    const fixture = await withFixture();
    const service = new SsoConfigService(db, env);
    expect(await service.getEffectiveConfig(fixture.organizationId)).toBeNull();
  });

  it('setConfig() stores an OIDC config with an encrypted secret, masked in getEffectiveConfig()', async () => {
    const fixture = await withFixture();
    const service = new SsoConfigService(db, env);

    const result = await service.setConfig(fixture.organizationId, {
      protocol: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      clientSecret: 'super-secret',
    });
    expect(result.protocol).toBe('oidc');
    expect(result.config.issuerUrl).toBe('https://idp.example.com');
    expect(result.hasSecret).toBe(true);

    const { rows } = await db.query<{ secret_encrypted: Buffer }>(`SELECT secret_encrypted FROM sso_configs WHERE organization_id = $1`, [
      fixture.organizationId,
    ]);
    expect(rows[0]!.secret_encrypted.toString('utf8')).not.toContain('super-secret');
  });

  it('setConfig() stores a SAML config with no secret (public IdP metadata only)', async () => {
    const fixture = await withFixture();
    const service = new SsoConfigService(db, env);

    const result = await service.setConfig(fixture.organizationId, {
      protocol: 'saml',
      entityId: 'https://sp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----',
    });
    expect(result.protocol).toBe('saml');
    expect(result.hasSecret).toBe(false);
  });

  it('resolve() decrypts the secret for actual use', async () => {
    const fixture = await withFixture();
    const service = new SsoConfigService(db, env);
    await service.setConfig(fixture.organizationId, {
      protocol: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      clientSecret: 'super-secret',
    });

    const resolved = await service.resolve(fixture.organizationId);
    expect(resolved?.secret).toBe('super-secret');
    expect(resolved?.config.clientId).toBe('client-123');
  });

  it('resolve() returns null for a disabled org (delete then re-check)', async () => {
    const fixture = await withFixture();
    const service = new SsoConfigService(db, env);
    await service.setConfig(fixture.organizationId, {
      protocol: 'saml',
      entityId: 'https://sp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'cert',
    });

    await service.delete(fixture.organizationId);
    expect(await service.resolve(fixture.organizationId)).toBeNull();
    expect(await service.getEffectiveConfig(fixture.organizationId)).toBeNull();
  });

  it('setConfig() upserts — switching protocol replaces the row, not appends', async () => {
    const fixture = await withFixture();
    const service = new SsoConfigService(db, env);

    await service.setConfig(fixture.organizationId, {
      protocol: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      clientSecret: 'secret',
    });
    const second = await service.setConfig(fixture.organizationId, {
      protocol: 'saml',
      entityId: 'https://sp.example.com',
      ssoUrl: 'https://idp.example.com/sso',
      certificate: 'cert',
    });

    expect(second.protocol).toBe('saml');
    const { rows } = await db.query(`SELECT COUNT(*) AS count FROM sso_configs WHERE organization_id = $1`, [fixture.organizationId]);
    expect(Number((rows[0] as { count: string }).count)).toBe(1);
  });

  it('delete() throws for an org with no config', async () => {
    const fixture = await withFixture();
    const service = new SsoConfigService(db, env);
    await expect(service.delete(fixture.organizationId)).rejects.toThrow();
  });

  it('RT-019: resolve() transparently re-encrypts a secret onto the new key after a simulated CONFIG_ENCRYPTION_KEY rotation', async () => {
    const fixture = await withFixture();

    // Simulates the state before rotation: this is the only key that has ever existed.
    const preRotationEnv = createTestEnv({ CONFIG_ENCRYPTION_KEY: 'c'.repeat(64) });
    const serviceBefore = new SsoConfigService(db, preRotationEnv);
    await serviceBefore.setConfig(fixture.organizationId, {
      protocol: 'oidc',
      issuerUrl: 'https://idp.example.com',
      clientId: 'client-123',
      clientSecret: 'rotate-me',
    });

    const { rows: beforeRows } = await db.query<{ kms_key_id: string }>(
      `SELECT kms_key_id FROM sso_configs WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    const keyIdBeforeRotation = beforeRows[0]!.kms_key_id;

    // Simulates the operator rotating the key: the old value moves to
    // CONFIG_ENCRYPTION_KEY_PREVIOUS, a new CONFIG_ENCRYPTION_KEY is generated.
    const postRotationEnv = createTestEnv({
      CONFIG_ENCRYPTION_KEY: 'd'.repeat(64),
      CONFIG_ENCRYPTION_KEY_PREVIOUS: 'c'.repeat(64),
    });
    const serviceAfter = new SsoConfigService(db, postRotationEnv);

    // First read after rotation: still decrypts correctly (via the previous-key fingerprint) ...
    const resolved = await serviceAfter.resolve(fixture.organizationId);
    expect(resolved?.secret).toBe('rotate-me');

    // ... and re-encrypt-on-read should have rewritten the row onto the new current key.
    const { rows: afterRows } = await db.query<{ kms_key_id: string }>(
      `SELECT kms_key_id FROM sso_configs WHERE organization_id = $1`,
      [fixture.organizationId],
    );
    expect(afterRows[0]!.kms_key_id).not.toBe(keyIdBeforeRotation);

    // A second read no longer needs CONFIG_ENCRYPTION_KEY_PREVIOUS at all.
    const envWithoutPreviousKey = createTestEnv({ CONFIG_ENCRYPTION_KEY: 'd'.repeat(64) });
    const serviceFullyRotated = new SsoConfigService(db, envWithoutPreviousKey);
    const resolvedAgain = await serviceFullyRotated.resolve(fixture.organizationId);
    expect(resolvedAgain?.secret).toBe('rotate-me');
  });
});
