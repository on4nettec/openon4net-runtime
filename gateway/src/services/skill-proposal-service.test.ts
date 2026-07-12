import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { SkillProposalService } from './skill-proposal-service.js';

async function seedProposal(db: Db, organizationId: string, agentId: string) {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO skill_proposals (agent_id, organization_id, proposed_definition, pattern_metadata)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      agentId,
      organizationId,
      JSON.stringify({ trigger: { type: 'manual' }, steps: [{ id: 'step-1', type: 'tool', tool: 'webhook-send', params: { url: 'https://example.com', payload: {} } }] }),
      JSON.stringify({ actionType: 'tool-webhook-send', occurrences: 6, windowDays: 7 }),
    ],
  );
  return rows[0]!.id;
}

describe('SkillProposalService', () => {
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

  it('lists pending proposals and rejects one', async () => {
    const fixture = await withFixture();
    const service = new SkillProposalService(db);
    const proposalId = await seedProposal(db, fixture.organizationId, fixture.agentId);

    const pending = await service.listPending(fixture.organizationId);
    expect(pending.some((p) => p.id === proposalId)).toBe(true);

    await service.resolve(fixture.organizationId, proposalId, 'rejected', fixture.userId);
    await expect(service.getPendingById(fixture.organizationId, proposalId)).rejects.toThrow();
  });

  it('rejects re-resolving an already-resolved proposal', async () => {
    const fixture = await withFixture();
    const service = new SkillProposalService(db);
    const proposalId = await seedProposal(db, fixture.organizationId, fixture.agentId);

    await service.resolve(fixture.organizationId, proposalId, 'approved', fixture.userId);
    await expect(service.getPendingById(fixture.organizationId, proposalId)).rejects.toThrow();
  });
});
