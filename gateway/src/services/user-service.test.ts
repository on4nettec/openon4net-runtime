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

  describe('seat limit enforcement (RT-081)', () => {
    it('personal activation blocks creating a second user (fixture already has one)', async () => {
      const fixture = await withFixture();
      await db.query(`UPDATE organizations SET activation_type = 'personal', max_users = NULL WHERE id = $1`, [
        fixture.organizationId,
      ]);
      const userService = new UserService(db);

      await expect(
        userService.create(fixture.organizationId, {
          email: `${uniqueSlug('user')}@example.com`,
          name: 'Second Person',
          role: 'viewer',
        }),
      ).rejects.toThrow(/personal activation/);
    });

    it('organizational activation allows up to max_users, then rejects the next one', async () => {
      const fixture = await withFixture(); // fixture already seeded 1 active user
      await seedRole(db, fixture.organizationId, 'viewer');
      await db.query(`UPDATE organizations SET activation_type = 'organizational', max_users = 2 WHERE id = $1`, [
        fixture.organizationId,
      ]);
      const userService = new UserService(db);

      // 1 existing (fixture) + this one = 2, at the cap.
      await userService.create(fixture.organizationId, {
        email: `${uniqueSlug('user')}@example.com`,
        name: 'Second',
        role: 'viewer',
      });

      await expect(
        userService.create(fixture.organizationId, {
          email: `${uniqueSlug('user')}@example.com`,
          name: 'Third',
          role: 'viewer',
        }),
      ).rejects.toThrow(/user limit of 2/);
    });

    it('max_users = null means unlimited even for organizational activation', async () => {
      const fixture = await withFixture();
      await seedRole(db, fixture.organizationId, 'viewer');
      await db.query(`UPDATE organizations SET activation_type = 'organizational', max_users = NULL WHERE id = $1`, [
        fixture.organizationId,
      ]);
      const userService = new UserService(db);

      const user = await userService.create(fixture.organizationId, {
        email: `${uniqueSlug('user')}@example.com`,
        name: 'Unlimited',
        role: 'viewer',
      });
      expect(user.id).toBeTruthy();
    });

    it('a deactivated user frees up their seat', async () => {
      const fixture = await withFixture();
      await seedRole(db, fixture.organizationId, 'viewer');
      const userService = new UserService(db);
      await userService.update(fixture.organizationId, fixture.userId, { isActive: false });
      await db.query(`UPDATE organizations SET activation_type = 'personal', max_users = NULL WHERE id = $1`, [
        fixture.organizationId,
      ]);

      const user = await userService.create(fixture.organizationId, {
        email: `${uniqueSlug('user')}@example.com`,
        name: 'Replacement',
        role: 'viewer',
      });
      expect(user.id).toBeTruthy();
    });
  });

  describe('language (RT-083)', () => {
    it('a newly created user has no language preference (null = inherit org default / first-login signal)', async () => {
      const fixture = await withFixture();
      await seedRole(db, fixture.organizationId, 'viewer');
      const userService = new UserService(db);

      const user = await userService.create(fixture.organizationId, {
        email: `${uniqueSlug('user')}@example.com`,
        name: 'Fresh User',
        role: 'viewer',
      });
      expect(user.language).toBeNull();
    });

    it('updateOwnLanguage sets a personal override, scoped to that user only', async () => {
      const fixture = await withFixture();
      const userService = new UserService(db);

      const updated = await userService.updateOwnLanguage(fixture.userId, 'fr');
      expect(updated.language).toBe('fr');

      const refreshed = await userService.findById(fixture.userId);
      expect(refreshed?.language).toBe('fr');
    });

    it('updateOwnLanguage throws NotFoundError for an unknown user id', async () => {
      const userService = new UserService(db);
      await expect(userService.updateOwnLanguage('00000000-0000-0000-0000-000000000000', 'fr')).rejects.toThrow();
    });
  });
});
