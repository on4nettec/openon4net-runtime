import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { detectSkillPatterns } from './skill-pattern-detector.js';

async function seedWebhookAuditRows(db: Db, organizationId: string, agentId: string, count: number, url: string): Promise<void> {
  for (let i = 0; i < count; i++) {
    await db.query(
      `INSERT INTO audit_logs (organization_id, agent_id, action_type, action_data, status) VALUES ($1, $2, 'tool-webhook-send', $3, 'success')`,
      [organizationId, agentId, JSON.stringify({ traceId: `t${i}`, url, statusCode: 200 })],
    );
  }
}

describe('detectSkillPatterns', () => {
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

  it('creates a proposal when both frequency and similarity pass', async () => {
    const fixture = await withFixture();
    await seedWebhookAuditRows(db, fixture.organizationId, fixture.agentId, 6, 'https://example.com/hook');

    await detectSkillPatterns(db);

    const { rows } = await db.query<{ pattern_metadata: Record<string, unknown>; proposed_definition: { steps: { params: { url: string } }[] } }>(
      `SELECT pattern_metadata, proposed_definition FROM skill_proposals WHERE agent_id = $1`,
      [fixture.agentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pattern_metadata.actionType).toBe('tool-webhook-send');
    expect(rows[0]!.pattern_metadata.occurrences).toBe(6);
    expect(rows[0]!.proposed_definition.steps[0]?.params.url).toBe('https://example.com/hook');
  });

  it('does not create a proposal below the frequency threshold', async () => {
    const fixture = await withFixture();
    await seedWebhookAuditRows(db, fixture.organizationId, fixture.agentId, 4, 'https://example.com/hook');

    await detectSkillPatterns(db);

    const { rows } = await db.query(`SELECT 1 FROM skill_proposals WHERE agent_id = $1`, [fixture.agentId]);
    expect(rows).toHaveLength(0);
  });

  it('does not create a proposal when the similarity check fails (different urls each time)', async () => {
    const fixture = await withFixture();
    for (let i = 0; i < 6; i++) {
      await seedWebhookAuditRows(db, fixture.organizationId, fixture.agentId, 1, `https://example.com/hook-${i}`);
    }

    await detectSkillPatterns(db);

    const { rows } = await db.query(`SELECT 1 FROM skill_proposals WHERE agent_id = $1`, [fixture.agentId]);
    expect(rows).toHaveLength(0);
  });

  it('does not create a duplicate proposal for an already-pending pattern', async () => {
    const fixture = await withFixture();
    await seedWebhookAuditRows(db, fixture.organizationId, fixture.agentId, 6, 'https://example.com/hook');

    await detectSkillPatterns(db);
    await detectSkillPatterns(db);

    const { rows } = await db.query(`SELECT 1 FROM skill_proposals WHERE agent_id = $1`, [fixture.agentId]);
    expect(rows).toHaveLength(1);
  });
});
