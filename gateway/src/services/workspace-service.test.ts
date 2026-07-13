import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb, uniqueSlug } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { WorkspaceService } from './workspace-service.js';

describe('WorkspaceService', () => {
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

  it('update changes name/description', async () => {
    const fixture = await withFixture();
    const workspaceService = new WorkspaceService(db);

    const updated = await workspaceService.update(fixture.organizationId, fixture.workspaceId, {
      name: 'Renamed workspace',
      description: 'new description',
    });
    expect(updated.name).toBe('Renamed workspace');
    expect(updated.description).toBe('new description');
  });

  it('update throws NotFoundError for a workspace outside the organization', async () => {
    const fixture = await withFixture();
    const other = await withFixture();
    const workspaceService = new WorkspaceService(db);

    await expect(
      workspaceService.update(fixture.organizationId, other.workspaceId, { name: 'nope' }),
    ).rejects.toThrow();
  });

  it('archive flips status to archived and excludes it from list() by default', async () => {
    const fixture = await withFixture();
    const workspaceService = new WorkspaceService(db);

    const second = await workspaceService.create(fixture.organizationId, { name: uniqueSlug('extra-ws') });

    const archived = await workspaceService.archive(fixture.organizationId, second.id);
    expect(archived.status).toBe('archived');

    const activeOnly = await workspaceService.list(fixture.organizationId);
    expect(activeOnly.some((w) => w.id === second.id)).toBe(false);

    const withArchived = await workspaceService.list(fixture.organizationId, { includeArchived: true });
    expect(withArchived.some((w) => w.id === second.id)).toBe(true);
  });

  it('isActive reflects current status, false for unknown workspace ids', async () => {
    const fixture = await withFixture();
    const workspaceService = new WorkspaceService(db);

    expect(await workspaceService.isActive(fixture.organizationId, fixture.workspaceId)).toBe(true);

    await workspaceService.archive(fixture.organizationId, fixture.workspaceId);
    expect(await workspaceService.isActive(fixture.organizationId, fixture.workspaceId)).toBe(false);

    expect(await workspaceService.isActive(fixture.organizationId, '00000000-0000-0000-0000-000000000000')).toBe(
      false,
    );
  });
});
