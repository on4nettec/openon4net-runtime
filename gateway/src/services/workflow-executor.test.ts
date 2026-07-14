import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../context.js';
import { createTestContext } from '../test-support/context.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { WorkflowService } from './workflow-service.js';
import { WorkflowRunService } from './workflow-run-service.js';
import { ApprovalService } from './approval-service.js';
import { WorkflowExecutor } from './workflow-executor.js';

const webhookStep = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'tool' as const,
  tool: 'webhook-send' as const,
  params: { url: 'https://postman-echo.com/post', payload: extra },
});

describe('WorkflowExecutor', () => {
  let ctx: AppContext;
  const createdOrgIds: string[] = [];

  beforeAll(() => {
    ctx = createTestContext();
  });

  afterEach(async () => {
    for (const id of createdOrgIds.splice(0)) {
      await cleanupTestFixture(ctx.db, id);
    }
  });

  afterAll(async () => {
    await ctx.db.end();
    ctx.redis.disconnect();
  });

  async function withFixture(): Promise<TestFixture> {
    const fixture = await createTestFixture(ctx.db);
    createdOrgIds.push(fixture.organizationId);
    return fixture;
  }

  it(
    'runs sequential tool steps in order and completes the run successfully',
    async () => {
      const fixture = await withFixture();
      const workflowService = new WorkflowService(ctx.db);
      const executor = new WorkflowExecutor(ctx);

      const workflow = await workflowService.create(
        fixture.organizationId,
        { name: 'Sequential', trigger: { type: 'manual' }, definition: { steps: [webhookStep('step-1'), webhookStep('step-2')] } },
        fixture.userId,
      );

      const run = await executor.start(fixture.organizationId, workflow.id, fixture.userId);
      expect(run.status).toBe('success');
      expect(run.context['step-1']).toEqual({ statusCode: 200 });
      expect(run.context['step-2']).toEqual({ statusCode: 200 });
    },
    15000,
  );

  it(
    'condition step jumps to the matching branch and skips the other one',
    async () => {
      const fixture = await withFixture();
      const workflowService = new WorkflowService(ctx.db);
      const executor = new WorkflowExecutor(ctx);

      const workflow = await workflowService.create(
        fixture.organizationId,
        {
          name: 'Branching',
          trigger: { type: 'manual' },
          definition: {
            steps: [
              webhookStep('step-0'),
              {
                id: 'cond',
                type: 'condition',
                field: 'step-0.statusCode',
                op: 'eq',
                value: 200,
                then: 'then-step',
                else: 'else-step',
              },
              webhookStep('else-step'),
              webhookStep('then-step'),
            ],
          },
        },
        fixture.userId,
      );

      const run = await executor.start(fixture.organizationId, workflow.id, fixture.userId);
      expect(run.status).toBe('success');
      expect(run.context['then-step']).toEqual({ statusCode: 200 });
      expect(run.context['else-step']).toBeUndefined();
    },
    15000,
  );

  it(
    'parallel step runs sub-steps concurrently and merges results under the step id',
    async () => {
      const fixture = await withFixture();
      const workflowService = new WorkflowService(ctx.db);
      const executor = new WorkflowExecutor(ctx);

      const workflow = await workflowService.create(
        fixture.organizationId,
        {
          name: 'Parallel',
          trigger: { type: 'manual' },
          definition: {
            steps: [{ id: 'par', type: 'parallel', steps: [webhookStep('sub-1'), webhookStep('sub-2')] }],
          },
        },
        fixture.userId,
      );

      const run = await executor.start(fixture.organizationId, workflow.id, fixture.userId);
      expect(run.status).toBe('success');
      expect(run.context.par).toEqual({ 'sub-1': { statusCode: 200 }, 'sub-2': { statusCode: 200 } });
    },
    15000,
  );

  it('human step pauses the run for approval, and approving it resumes and completes the run', async () => {
    const fixture = await withFixture();
    const workflowService = new WorkflowService(ctx.db);
    const runService = new WorkflowRunService(ctx.db);
    const approvalService = new ApprovalService(ctx.db);
    const executor = new WorkflowExecutor(ctx);

    const workflow = await workflowService.create(
      fixture.organizationId,
      { name: 'Needs approval', trigger: { type: 'manual' }, definition: { steps: [{ id: 'h1', type: 'human', reason: 'needs review' }] } },
      fixture.userId,
    );

    const run = await executor.start(fixture.organizationId, workflow.id, fixture.userId);
    expect(run.status).toBe('paused');
    expect(run.pendingApprovalId).toBeTruthy();

    await approvalService.resolve(fixture.organizationId, run.pendingApprovalId!, 'approved', fixture.userId);
    await executor.resumeFromApproval(run.id, true, fixture.userId);

    const resumed = await runService.getById(run.id);
    expect(resumed.status).toBe('success');
  });

  it('human step run fails once its approval is rejected', async () => {
    const fixture = await withFixture();
    const workflowService = new WorkflowService(ctx.db);
    const runService = new WorkflowRunService(ctx.db);
    const approvalService = new ApprovalService(ctx.db);
    const executor = new WorkflowExecutor(ctx);

    const workflow = await workflowService.create(
      fixture.organizationId,
      {
        name: 'Needs approval (rejected)',
        trigger: { type: 'manual' },
        definition: { steps: [{ id: 'h1', type: 'human', reason: 'needs review' }] },
      },
      fixture.userId,
    );

    const run = await executor.start(fixture.organizationId, workflow.id, fixture.userId);
    await approvalService.resolve(fixture.organizationId, run.pendingApprovalId!, 'rejected', fixture.userId);
    await executor.resumeFromApproval(run.id, false, fixture.userId);

    const resumed = await runService.getById(run.id);
    expect(resumed.status).toBe('failed');
  });

  it('agent step fails the run when no active agent matches the requested role', async () => {
    const fixture = await withFixture();
    const workflowService = new WorkflowService(ctx.db);
    const runService = new WorkflowRunService(ctx.db);
    const executor = new WorkflowExecutor(ctx);

    const workflow = await workflowService.create(
      fixture.organizationId,
      {
        name: 'Unroutable agent step',
        trigger: { type: 'manual' },
        definition: {
          steps: [{ id: 'a1', type: 'agent', agentRole: 'nonexistent-role', prompt: 'do something' }],
        },
      },
      fixture.userId,
    );

    await expect(executor.start(fixture.organizationId, workflow.id, fixture.userId)).rejects.toThrow();

    const runs = await runService.listForWorkflow(fixture.organizationId, workflow.id);
    expect(runs[0]?.status).toBe('failed');
  });
});
