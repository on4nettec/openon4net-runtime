import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { OrgService } from './org-service.js';

describe('OrgService', () => {
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

  it('getById returns the full organization row', async () => {
    const fixture = await withFixture();
    const orgService = new OrgService(db);

    const org = await orgService.getById(fixture.organizationId);
    expect(org.id).toBe(fixture.organizationId);
    expect(org.plan).toBe('starter');
    expect(org.status).toBe('active');
  });

  it('getById throws NotFoundError for an unknown id', async () => {
    const orgService = new OrgService(db);
    await expect(orgService.getById('00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });

  it('update changes the name and leaves settings untouched when omitted', async () => {
    const fixture = await withFixture();
    const orgService = new OrgService(db);

    const updated = await orgService.update(fixture.organizationId, { name: 'Renamed Org' });
    expect(updated.name).toBe('Renamed Org');

    const refreshed = await orgService.getById(fixture.organizationId);
    expect(refreshed.name).toBe('Renamed Org');
  });

  it('update can set settings independently of name', async () => {
    const fixture = await withFixture();
    const orgService = new OrgService(db);
    const before = await orgService.getById(fixture.organizationId);

    const updated = await orgService.update(fixture.organizationId, { settings: { theme: 'dark' } });
    expect(updated.settings).toEqual({ theme: 'dark' });
    expect(updated.name).toBe(before.name);
  });
});
