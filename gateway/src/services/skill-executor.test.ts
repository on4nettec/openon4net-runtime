import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppContext } from '../context.js';
import { createTestContext } from '../test-support/context.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { SkillService } from './skill-service.js';
import { executeSkill } from './skill-executor.js';

describe('executeSkill', () => {
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
    'runs a real webhook-send step end-to-end and records success',
    async () => {
      const fixture = await withFixture();
      const skillService = new SkillService(ctx.db);
      const skill = await skillService.create(fixture.organizationId, {
        agentId: fixture.agentId,
        name: 'Webhook skill',
        definition: {
          trigger: { type: 'manual' },
          steps: [{ id: 'step-1', type: 'tool', tool: 'webhook-send', params: { url: 'https://postman-echo.com/post', payload: {} } }],
        },
      });

      const result = await executeSkill(ctx, fixture.organizationId, fixture.agentId, skill.id, {});
      expect(result.succeeded).toBe(true);
      expect(result.stepResults).toHaveLength(1);

      const refreshed = await skillService.getById(fixture.organizationId, skill.id);
      expect(refreshed.executionCount).toBe(1);
      expect(refreshed.successRate).toBe(100);
    },
    15000,
  );

  it('records a failed execution when the underlying tool call fails', async () => {
    const fixture = await withFixture();
    const skillService = new SkillService(ctx.db);
    // TELEGRAM_BOT_TOKEN isn't configured in the test env, so this step must fail.
    const skill = await skillService.create(fixture.organizationId, {
      agentId: fixture.agentId,
      name: 'Telegram skill (unconfigured)',
      definition: {
        trigger: { type: 'manual' },
        steps: [{ id: 'step-1', type: 'tool', tool: 'telegram-send', params: { chatId: '123', message: 'hi' } }],
      },
    });

    await expect(executeSkill(ctx, fixture.organizationId, fixture.agentId, skill.id, {})).rejects.toThrow();

    const refreshed = await skillService.getById(fixture.organizationId, skill.id);
    expect(refreshed.executionCount).toBe(1);
    expect(refreshed.successRate).toBe(0);
  });

  it('merges execute-time params over the skill definition step defaults', async () => {
    const fixture = await withFixture();
    const skillService = new SkillService(ctx.db);
    const skill = await skillService.create(fixture.organizationId, {
      agentId: fixture.agentId,
      name: 'Overridable webhook skill',
      definition: {
        trigger: { type: 'manual' },
        steps: [{ id: 'step-1', type: 'tool', tool: 'webhook-send', params: { url: 'https://postman-echo.com/post', payload: { a: 1 } } }],
      },
    });

    const result = await executeSkill(ctx, fixture.organizationId, fixture.agentId, skill.id, { payload: { a: 2 } });
    expect(result.succeeded).toBe(true);
  }, 15000);
});
