import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AgentCreateSchema } from '@o2n/shared';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { AgentService } from './agent-service.js';

describe('AgentService', () => {
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

  it('rejects an agent reporting to itself', async () => {
    const fixture = await withFixture();
    const agentService = new AgentService(db);

    await expect(
      agentService.update(fixture.organizationId, fixture.agentId, { reportsTo: fixture.agentId }),
    ).rejects.toThrow();
  });

  it('rejects a reportsTo change that would create a cycle', async () => {
    const fixture = await withFixture();
    const agentService = new AgentService(db);

    const b = await agentService.create(
      fixture.organizationId,
      AgentCreateSchema.parse({ name: 'B', role: 'tester', workspaceId: fixture.workspaceId }),
    );
    await agentService.update(fixture.organizationId, b.id, { reportsTo: fixture.agentId });

    // fixture.agentId (A) reporting to b (B) would create A -> B -> A.
    await expect(
      agentService.update(fixture.organizationId, fixture.agentId, { reportsTo: b.id }),
    ).rejects.toThrow();
  });

  it('listReports returns direct reports only, not deeper descendants', async () => {
    const fixture = await withFixture();
    const agentService = new AgentService(db);

    const b = await agentService.create(
      fixture.organizationId,
      AgentCreateSchema.parse({
        name: 'B',
        role: 'tester',
        workspaceId: fixture.workspaceId,
        reportsTo: fixture.agentId,
      }),
    );
    const c = await agentService.create(
      fixture.organizationId,
      AgentCreateSchema.parse({ name: 'C', role: 'tester', workspaceId: fixture.workspaceId, reportsTo: b.id }),
    );

    const reports = await agentService.listReports(fixture.organizationId, fixture.agentId);
    expect(reports.map((a) => a.id)).toEqual([b.id]);
    expect(reports.map((a) => a.id)).not.toContain(c.id);
  });

  it('listTeam returns the full transitive subtree', async () => {
    const fixture = await withFixture();
    const agentService = new AgentService(db);

    const b = await agentService.create(
      fixture.organizationId,
      AgentCreateSchema.parse({
        name: 'B',
        role: 'tester',
        workspaceId: fixture.workspaceId,
        reportsTo: fixture.agentId,
      }),
    );
    const c = await agentService.create(
      fixture.organizationId,
      AgentCreateSchema.parse({ name: 'C', role: 'tester', workspaceId: fixture.workspaceId, reportsTo: b.id }),
    );

    const team = await agentService.listTeam(fixture.organizationId, fixture.agentId);
    const teamIds = team.map((a) => a.id);
    expect(teamIds).toContain(b.id);
    expect(teamIds).toContain(c.id);
  });

  it('updateKpis replaces kpi_config.kpis, reflected by getById', async () => {
    const fixture = await withFixture();
    const agentService = new AgentService(db);

    const updated = await agentService.updateKpis(fixture.organizationId, fixture.agentId, [
      { name: 'Tickets closed', target: 100, current: 40 },
    ]);
    expect(updated.kpiConfig).toEqual({ kpis: [{ name: 'Tickets closed', target: 100, current: 40 }] });

    const refreshed = await agentService.getById(fixture.organizationId, fixture.agentId);
    expect(refreshed.kpiConfig).toEqual({ kpis: [{ name: 'Tickets closed', target: 100, current: 40 }] });
  });

  it('findByRole returns the first active match, null if none', async () => {
    const fixture = await withFixture();
    const agentService = new AgentService(db);

    const match = await agentService.findByRole(fixture.organizationId, 'tester');
    expect(match?.id).toBe(fixture.agentId);

    const none = await agentService.findByRole(fixture.organizationId, 'nonexistent-role');
    expect(none).toBeNull();
  });
});
