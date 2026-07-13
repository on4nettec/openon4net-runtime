import { verify as argon2Verify } from '@node-rs/argon2';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb, uniqueSlug } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { seedRole } from '../test-support/roles.js';
import { InvitationService } from './invitation-service.js';

describe('InvitationService', () => {
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

  it('create rejects a role that does not exist for the org', async () => {
    const fixture = await withFixture();
    const invitationService = new InvitationService(db);

    await expect(
      invitationService.create(fixture.organizationId, fixture.userId, {
        email: `${uniqueSlug('invitee')}@example.com`,
        role: 'no-such-role',
      }),
    ).rejects.toThrow();
  });

  it('create then list shows it pending', async () => {
    const fixture = await withFixture();
    await seedRole(db, fixture.organizationId, 'viewer');
    const invitationService = new InvitationService(db);
    const email = `${uniqueSlug('invitee')}@example.com`;

    const { invitation, token } = await invitationService.create(fixture.organizationId, fixture.userId, {
      email,
      role: 'viewer',
    });
    expect(invitation.status).toBe('pending');
    expect(token).toHaveLength(64); // 32 bytes hex

    const pending = await invitationService.listPending(fixture.organizationId);
    expect(pending.some((i) => i.id === invitation.id)).toBe(true);
  });

  it('accept creates a real user with a verifiable password hash and marks the invitation accepted', async () => {
    const fixture = await withFixture();
    await seedRole(db, fixture.organizationId, 'viewer');
    const invitationService = new InvitationService(db);
    const email = `${uniqueSlug('invitee')}@example.com`;

    const { token } = await invitationService.create(fixture.organizationId, fixture.userId, { email, role: 'viewer' });

    const result = await invitationService.accept(token, { name: 'New Person', password: 'a-real-password-123' });
    expect(result.organizationId).toBe(fixture.organizationId);
    expect(result.user.email).toBe(email);
    expect(result.user.role).toBe('viewer');

    const { rows } = await db.query<{ password_hash: string; role: string }>(
      `SELECT password_hash, role FROM users WHERE id = $1`,
      [result.user.id],
    );
    expect(await argon2Verify(rows[0]!.password_hash, 'a-real-password-123')).toBe(true);

    const pending = await invitationService.listPending(fixture.organizationId);
    expect(pending).toHaveLength(0);
  });

  it('accept rejects an already-accepted token (no double-accept)', async () => {
    const fixture = await withFixture();
    await seedRole(db, fixture.organizationId, 'viewer');
    const invitationService = new InvitationService(db);
    const { token } = await invitationService.create(fixture.organizationId, fixture.userId, {
      email: `${uniqueSlug('invitee')}@example.com`,
      role: 'viewer',
    });

    await invitationService.accept(token, { name: 'First', password: 'a-real-password-123' });
    await expect(invitationService.accept(token, { name: 'Second', password: 'a-real-password-123' })).rejects.toThrow();
  });

  it('accept rejects an expired token', async () => {
    const fixture = await withFixture();
    await seedRole(db, fixture.organizationId, 'viewer');
    const invitationService = new InvitationService(db);
    const { invitation, token } = await invitationService.create(fixture.organizationId, fixture.userId, {
      email: `${uniqueSlug('invitee')}@example.com`,
      role: 'viewer',
    });

    await db.query(`UPDATE invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1`, [invitation.id]);

    await expect(invitationService.accept(token, { name: 'Late', password: 'a-real-password-123' })).rejects.toThrow();
  });

  it('revoke marks a pending invitation revoked and removes it from listPending', async () => {
    const fixture = await withFixture();
    await seedRole(db, fixture.organizationId, 'viewer');
    const invitationService = new InvitationService(db);
    const { invitation } = await invitationService.create(fixture.organizationId, fixture.userId, {
      email: `${uniqueSlug('invitee')}@example.com`,
      role: 'viewer',
    });

    await invitationService.revoke(fixture.organizationId, invitation.id);
    const pending = await invitationService.listPending(fixture.organizationId);
    expect(pending.some((i) => i.id === invitation.id)).toBe(false);
  });

  it('revoke throws NotFoundError for an unknown or already-resolved invitation', async () => {
    const fixture = await withFixture();
    const invitationService = new InvitationService(db);

    await expect(invitationService.revoke(fixture.organizationId, '00000000-0000-0000-0000-000000000000')).rejects.toThrow();
  });
});
