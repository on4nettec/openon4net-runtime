import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { WorkspaceFileService } from './workspace-file-service.js';

describe('WorkspaceFileService (RT-025)', () => {
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

  it('creates a file record and lists it back by workspace', async () => {
    const fixture = await withFixture();
    const service = new WorkspaceFileService(db);

    const file = await service.create({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      filename: 'notes.txt',
      storageKey: `workspaces/${fixture.workspaceId}/notes.txt`,
      contentType: 'text/plain',
      sizeBytes: 42,
      uploadedByUserId: fixture.userId,
    });

    expect(file.filename).toBe('notes.txt');
    expect(file.sizeBytes).toBe(42);

    const listed = await service.listByWorkspace(fixture.workspaceId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(file.id);
  });

  it('getById is org-scoped — a file from one org never resolves for another', async () => {
    const fixtureA = await withFixture();
    const fixtureB = await withFixture();
    const service = new WorkspaceFileService(db);

    const file = await service.create({
      workspaceId: fixtureA.workspaceId,
      organizationId: fixtureA.organizationId,
      filename: 'secret.txt',
      storageKey: 'workspaces/a/secret.txt',
      contentType: 'text/plain',
      sizeBytes: 10,
      uploadedByUserId: fixtureA.userId,
    });

    expect(await service.getById(fixtureA.organizationId, file.id)).not.toBeNull();
    expect(await service.getById(fixtureB.organizationId, file.id)).toBeNull();
  });

  it('delete() removes the row and returns it, so the caller can also delete the underlying object', async () => {
    const fixture = await withFixture();
    const service = new WorkspaceFileService(db);
    const file = await service.create({
      workspaceId: fixture.workspaceId,
      organizationId: fixture.organizationId,
      filename: 'temp.txt',
      storageKey: `workspaces/${fixture.workspaceId}/temp.txt`,
      contentType: 'text/plain',
      sizeBytes: 5,
      uploadedByUserId: fixture.userId,
    });

    const deleted = await service.delete(fixture.organizationId, file.id);
    expect(deleted?.storageKey).toBe(file.storageKey);
    expect(await service.getById(fixture.organizationId, file.id)).toBeNull();
  });

  it('delete() returns null for a file id that does not exist', async () => {
    const fixture = await withFixture();
    const service = new WorkspaceFileService(db);
    expect(await service.delete(fixture.organizationId, '00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
