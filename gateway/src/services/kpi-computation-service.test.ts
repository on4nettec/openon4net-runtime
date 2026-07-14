import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { computeMetric, computeOrgMetric, listKpiSnapshots } from './kpi-computation-service.js';

async function seedAuditRow(
  db: Db,
  organizationId: string,
  agentId: string,
  status: 'success' | 'failed',
  costCents: number,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (organization_id, agent_id, action_type, action_data, status, cost_cents) VALUES ($1, $2, 'agent-chat', '{}', $3, $4)`,
    [organizationId, agentId, status, costCents],
  );
}

describe('kpi-computation-service', () => {
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

  it('computeMetric action_count counts rows within the window, scoped to the agent', async () => {
    const fixture = await withFixture();
    const other = await withFixture();
    await seedAuditRow(db, fixture.organizationId, fixture.agentId, 'success', 10);
    await seedAuditRow(db, fixture.organizationId, fixture.agentId, 'success', 20);
    await seedAuditRow(db, other.organizationId, other.agentId, 'success', 10); // different agent, must not count

    const count = await computeMetric(db, fixture.agentId, 'action_count', 7);
    expect(count).toBe(2);
  });

  it('computeMetric cost_cents sums cost across matching rows', async () => {
    const fixture = await withFixture();
    await seedAuditRow(db, fixture.organizationId, fixture.agentId, 'success', 150);
    await seedAuditRow(db, fixture.organizationId, fixture.agentId, 'success', 250);

    const total = await computeMetric(db, fixture.agentId, 'cost_cents', 7);
    expect(total).toBe(400);
  });

  it('computeMetric success_rate is a percentage of successful rows', async () => {
    const fixture = await withFixture();
    await seedAuditRow(db, fixture.organizationId, fixture.agentId, 'success', 10);
    await seedAuditRow(db, fixture.organizationId, fixture.agentId, 'success', 10);
    await seedAuditRow(db, fixture.organizationId, fixture.agentId, 'failed', 10);
    await seedAuditRow(db, fixture.organizationId, fixture.agentId, 'failed', 10);

    const rate = await computeMetric(db, fixture.agentId, 'success_rate', 7);
    expect(rate).toBe(50);
  });

  it('computeMetric returns zero when there are no matching rows', async () => {
    const fixture = await withFixture();
    expect(await computeMetric(db, fixture.agentId, 'action_count', 7)).toBe(0);
    expect(await computeMetric(db, fixture.agentId, 'cost_cents', 7)).toBe(0);
    expect(await computeMetric(db, fixture.agentId, 'success_rate', 7)).toBe(0);
  });

  it('computeOrgMetric aggregates across every agent in the organization', async () => {
    const fixture = await withFixture();
    const other = await withFixture();
    await seedAuditRow(db, fixture.organizationId, fixture.agentId, 'success', 100);
    await seedAuditRow(db, other.organizationId, other.agentId, 'success', 999); // different org, must not count

    const total = await computeOrgMetric(db, fixture.organizationId, 'cost_cents', 7);
    expect(total).toBe(100);
  });

  it('listKpiSnapshots returns snapshots for the given agent/kpi, oldest first', async () => {
    const fixture = await withFixture();
    await db.query(`INSERT INTO agent_kpi_snapshots (agent_id, kpi_name, value) VALUES ($1, 'usage', 10)`, [fixture.agentId]);
    await db.query(`INSERT INTO agent_kpi_snapshots (agent_id, kpi_name, value) VALUES ($1, 'usage', 20)`, [fixture.agentId]);
    await db.query(`INSERT INTO agent_kpi_snapshots (agent_id, kpi_name, value) VALUES ($1, 'other-kpi', 999)`, [fixture.agentId]);

    const snapshots = await listKpiSnapshots(db, fixture.agentId, 'usage');
    expect(snapshots.map((s) => s.value)).toEqual([10, 20]);
  });
});
