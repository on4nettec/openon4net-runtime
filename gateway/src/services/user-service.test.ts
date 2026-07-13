import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb, uniqueSlug } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { seedRole } from '../test-support/roles.js';
import { UserService } from './user-service.js';
import { WorkspaceService } from './workspace-service.js';

describe('UserService', () => {
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

  it('creates a user bound to a custom role name, in the org default workspace when omitted', async () => {
    const fixture = await withFixture();
    await seedRole(db, fixture.organizationId, 'sales-manager', ['agents:read']);
    const userService = new UserService(db);

    const user = await userService.create(fixture.organizationId, {
      email: `${uniqueSlug('user')}@example.com`,
      name: 'Sales Person',
      role: 'sales-manager',
    });
    expect(user.role).toBe('sales-manager');

    const { rows } = await db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM user_role_bindings WHERE user_id = $1`,
      [user.id],
    );
    expect(rows[0]?.workspace_id).toBe(fixture.workspaceId);
  });

  it('creates a user in an explicitly chosen workspace', async () => {
    const fixture = await withFixture();
    await seedRole(db, fixture.organizationId, 'editor');
    const workspaceService = new WorkspaceService(db);
    const secondWorkspace = await workspaceService.create(fixture.organizationId, { name: uniqueSlug('ws') });
    const userService = new UserService(db);

    const user = await userService.create(fixture.organizationId, {
      email: `${uniqueSlug('user')}@example.com`,
      name: 'Someone',
      role: 'editor',
      workspaceId: secondWorkspace.id,
    });

    const { rows } = await db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM user_role_bindings WHERE user_id = $1`,
      [user.id],
    );
    expect(rows[0]?.workspace_id).toBe(secondWorkspace.id);
  });

  it('rejects a role name that does not exist for the org', async () => {
    const fixture = await withFixture();
    const userService = new UserService(db);

    await expect(
      userService.create(fixture.organizationId, {
        email: `${uniqueSlug('user')}@example.com`,
        name: 'Nobody',
        role: 'does-not-exist',
      }),
    ).rejects.toThrow();
  });

  it('rejects a duplicate email within the same organization', async () => {
    const fixture = await withFixture();
    await seedRole(db, fixture.organizationId, 'viewer');
    const userService = new UserService(db);
    const email = `${uniqueSlug('dup')}@example.com`;

    await userService.create(fixture.organizationId, { email, name: 'First', role: 'viewer' });
    await expect(userService.create(fixture.organizationId, { email, name: 'Second', role: 'viewer' })).rejects.toThrow();
  });

  it('update can move a user to a different workspace without changing their role', async () => {
    const fixture = await withFixture();
    await seedRole(db, fixture.organizationId, 'viewer');
    const workspaceService = new WorkspaceService(db);
    const secondWorkspace = await workspaceService.create(fixture.organizationId, { name: uniqueSlug('ws') });
    const userService = new UserService(db);

    const user = await userService.create(fixture.organizationId, {
      email: `${uniqueSlug('user')}@example.com`,
      name: 'Movable',
      role: 'viewer',
    });

    const updated = await userService.update(fixture.organizationId, user.id, { workspaceId: secondWorkspace.id });
    expect(updated.role).toBe('viewer');

    const { rows } = await db.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM user_role_bindings WHERE user_id = $1`,
      [user.id],
    );
    expect(rows[0]?.workspace_id).toBe(secondWorkspace.id);
  });
});
