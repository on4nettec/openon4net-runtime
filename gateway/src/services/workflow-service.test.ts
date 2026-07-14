import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@o2n/shared';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { WorkflowService } from './workflow-service.js';

const definition: WorkflowDefinition = {
  steps: [
    { id: 'step-1', type: 'tool', tool: 'webhook-send', params: { url: 'https://postman-echo.com/post', payload: {} } },
  ],
};

describe('WorkflowService', () => {
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

  it('create() stores the definition and defaults status to draft', async () => {
    const fixture = await withFixture();
    const workflowService = new WorkflowService(db);

    const workflow = await workflowService.create(fixture.organizationId, { name: 'My workflow', definition }, fixture.userId);
    expect(workflow.status).toBe('draft');
    expect(workflow.definition).toEqual(definition);
  });

  it('getById throws for a workflow outside the organization', async () => {
    const fixture = await withFixture();
    const other = await withFixture();
    const workflowService = new WorkflowService(db);

    const workflow = await workflowService.create(
      other.organizationId,
      { name: 'Other org workflow', definition },
      other.userId,
    );

    await expect(workflowService.getById(fixture.organizationId, workflow.id)).rejects.toThrow();
  });

  it('list() returns only the organization\'s workflows', async () => {
    const fixture = await withFixture();
    const other = await withFixture();
    const workflowService = new WorkflowService(db);

    const mine = await workflowService.create(fixture.organizationId, { name: 'Mine', definition }, fixture.userId);
    const theirs = await workflowService.create(other.organizationId, { name: 'Theirs', definition }, other.userId);

    const list = await workflowService.list(fixture.organizationId);
    expect(list.some((w) => w.id === mine.id)).toBe(true);
    expect(list.some((w) => w.id === theirs.id)).toBe(false);
  });

  it('update() changes name/status', async () => {
    const fixture = await withFixture();
    const workflowService = new WorkflowService(db);

    const workflow = await workflowService.create(
      fixture.organizationId,
      { name: 'Draft workflow', definition },
      fixture.userId,
    );
    const updated = await workflowService.update(fixture.organizationId, workflow.id, {
      name: 'Renamed',
      status: 'active',
    });

    expect(updated.name).toBe('Renamed');
    expect(updated.status).toBe('active');
  });
});
