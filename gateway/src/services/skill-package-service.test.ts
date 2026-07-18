import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { SkillPackageService } from './skill-package-service.js';
import { SkillPackageGrantService } from './skill-package-grant-service.js';

describe('SkillPackageService / SkillPackageGrantService (RT-087)', () => {
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

  it('creates, lists, updates, and deletes a skill package', async () => {
    const fixture = await withFixture();
    const service = new SkillPackageService(db);

    const created = await service.create(fixture.organizationId, {
      name: 'Invoice Parsing',
      description: 'Extracts totals from invoice PDFs.',
      instructions: '# Instructions\n\n1. Find the total line.\n2. Return it as JSON.',
    });
    expect(created.status).toBe('active');

    const listed = await service.list(fixture.organizationId);
    expect(listed.map((p) => p.id)).toContain(created.id);

    const updated = await service.update(fixture.organizationId, created.id, { description: 'Updated description' });
    expect(updated.description).toBe('Updated description');

    await service.delete(fixture.organizationId, created.id);
    await expect(service.getById(fixture.organizationId, created.id)).rejects.toThrow();
  });

  it('imports a raw SKILL.md file, parsing frontmatter into name/description', async () => {
    const fixture = await withFixture();
    const service = new SkillPackageService(db);

    const markdown = `---
name: Imported Skill
description: Came from a real SKILL.md file.
---

Do the thing described here.`;

    const pkg = await service.importFromMarkdown(fixture.organizationId, undefined, markdown);
    expect(pkg.name).toBe('Imported Skill');
    expect(pkg.description).toBe('Came from a real SKILL.md file.');
    expect(pkg.instructions).toBe('Do the thing described here.');
  });

  it('grants and revokes a skill package to/from a specific agent, and lists only what that agent has been granted', async () => {
    const fixture = await withFixture();
    const packageService = new SkillPackageService(db);
    const grantService = new SkillPackageGrantService(db);

    const pkg = await packageService.create(fixture.organizationId, {
      name: 'Refund Policy',
      description: 'Explains the refund policy to customers.',
      instructions: 'Refunds are allowed within 30 days of purchase.',
    });

    expect(await grantService.hasGrant(fixture.agentId, pkg.id)).toBe(false);
    expect(await packageService.listGrantedForAgent(fixture.organizationId, fixture.agentId)).toHaveLength(0);

    await grantService.grant(fixture.agentId, pkg.id, fixture.userId);
    expect(await grantService.hasGrant(fixture.agentId, pkg.id)).toBe(true);

    const granted = await packageService.listGrantedForAgent(fixture.organizationId, fixture.agentId);
    expect(granted).toHaveLength(1);
    expect(granted[0]?.id).toBe(pkg.id);

    await grantService.revoke(fixture.agentId, pkg.id);
    expect(await grantService.hasGrant(fixture.agentId, pkg.id)).toBe(false);
  });
});
