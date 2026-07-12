import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { SkillService } from './skill-service.js';
import { SkillGrantService } from './skill-grant-service.js';

describe('SkillService', () => {
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

  it('creates, lists, updates, and deletes a skill', async () => {
    const fixture = await withFixture();
    const skillService = new SkillService(db);

    const created = await skillService.create(fixture.organizationId, {
      agentId: fixture.agentId,
      name: 'Send status webhook',
      definition: {
        trigger: { type: 'manual' },
        steps: [{ id: 'step-1', type: 'tool', tool: 'webhook-send', params: { url: 'https://example.com', payload: {} } }],
      },
    });
    expect(created.id).toBeTruthy();
    expect(created.source).toBe('manual');
    expect(created.status).toBe('active');

    const list = await skillService.list(fixture.organizationId);
    expect(list.some((s) => s.id === created.id)).toBe(true);

    const updated = await skillService.update(fixture.organizationId, created.id, { name: 'Renamed' });
    expect(updated.name).toBe('Renamed');

    await skillService.delete(fixture.organizationId, created.id);
    await expect(skillService.getById(fixture.organizationId, created.id)).rejects.toThrow();
  });

  it('grants and revokes a skill to/from an agent', async () => {
    const fixture = await withFixture();
    const skillService = new SkillService(db);
    const grantService = new SkillGrantService(db);

    const skill = await skillService.create(fixture.organizationId, {
      agentId: fixture.agentId,
      name: 'Some skill',
      definition: {
        trigger: { type: 'manual' },
        steps: [{ id: 'step-1', type: 'tool', tool: 'webhook-send', params: { url: 'https://example.com', payload: {} } }],
      },
    });

    expect(await grantService.hasGrant(fixture.agentId, skill.id)).toBe(false);

    await grantService.grant(fixture.agentId, skill.id, fixture.userId);
    expect(await grantService.hasGrant(fixture.agentId, skill.id)).toBe(true);

    const grants = await grantService.listForAgent(fixture.agentId);
    expect(grants.some((g) => g.skillId === skill.id)).toBe(true);

    await grantService.revoke(fixture.agentId, skill.id);
    expect(await grantService.hasGrant(fixture.agentId, skill.id)).toBe(false);
  });

  it('recordExecution updates execution_count/success_rate/avg_duration_ms', async () => {
    const fixture = await withFixture();
    const skillService = new SkillService(db);

    const skill = await skillService.create(fixture.organizationId, {
      agentId: fixture.agentId,
      name: 'Metrics skill',
      definition: {
        trigger: { type: 'manual' },
        steps: [{ id: 'step-1', type: 'tool', tool: 'webhook-send', params: { url: 'https://example.com', payload: {} } }],
      },
    });

    await skillService.recordExecution(skill.id, true, 100);
    let refreshed = await skillService.getById(fixture.organizationId, skill.id);
    expect(refreshed.executionCount).toBe(1);
    expect(refreshed.successRate).toBe(100);
    expect(refreshed.avgDurationMs).toBe(100);

    await skillService.recordExecution(skill.id, false, 300);
    refreshed = await skillService.getById(fixture.organizationId, skill.id);
    expect(refreshed.executionCount).toBe(2);
    expect(refreshed.successRate).toBe(50);
    expect(refreshed.avgDurationMs).toBe(200);
  });
});
