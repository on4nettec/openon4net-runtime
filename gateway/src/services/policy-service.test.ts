import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createTestFixture, cleanupTestFixture, type TestFixture } from '../test-support/fixtures.js';
import { PolicyService } from './policy-service.js';

describe('PolicyService', () => {
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

  it('cost_gt_cents matches when the estimated cost exceeds the threshold', async () => {
    const fixture = await withFixture();
    const policyService = new PolicyService(db);
    await policyService.create(fixture.organizationId, 'Large spend', { type: 'cost_gt_cents', value: 1000 });

    const under = await policyService.evaluate(fixture.organizationId, { estimatedCostCents: 500 });
    expect(under.requiresApproval).toBe(false);

    const over = await policyService.evaluate(fixture.organizationId, { estimatedCostCents: 1500 });
    expect(over.requiresApproval).toBe(true);
    expect(over.matchedPolicyNames).toEqual(['Large spend']);
  });

  it('outside_hours matches based on the ctx.now override, wrapping midnight', async () => {
    const fixture = await withFixture();
    const policyService = new PolicyService(db);
    await policyService.create(fixture.organizationId, 'Business hours only', {
      type: 'outside_hours',
      startHour: 9,
      endHour: 17,
    });

    const duringHours = await policyService.evaluate(fixture.organizationId, {
      estimatedCostCents: 0,
      now: new Date('2026-01-01T12:00:00Z'),
    });
    expect(duringHours.requiresApproval).toBe(false);

    const afterHours = await policyService.evaluate(fixture.organizationId, {
      estimatedCostCents: 0,
      now: new Date('2026-01-01T22:00:00Z'),
    });
    expect(afterHours.requiresApproval).toBe(true);
  });

  it('action_type_in matches only when ctx.actionType is set and in the list (RT-056)', async () => {
    const fixture = await withFixture();
    const policyService = new PolicyService(db);
    await policyService.create(fixture.organizationId, 'Webhook calls need approval', {
      type: 'action_type_in',
      actionTypes: ['tool-webhook-send'],
    });

    // No actionType at all — e.g. a chat request — never matches this condition.
    const chatCtx = await policyService.evaluate(fixture.organizationId, { estimatedCostCents: 0 });
    expect(chatCtx.requiresApproval).toBe(false);

    const unrelatedAction = await policyService.evaluate(fixture.organizationId, {
      estimatedCostCents: 0,
      actionType: 'tool-telegram-send',
    });
    expect(unrelatedAction.requiresApproval).toBe(false);

    const matchingAction = await policyService.evaluate(fixture.organizationId, {
      estimatedCostCents: 0,
      actionType: 'tool-webhook-send',
    });
    expect(matchingAction.requiresApproval).toBe(true);
    expect(matchingAction.matchedPolicyNames).toEqual(['Webhook calls need approval']);
  });

  it('an inactive policy never matches', async () => {
    const fixture = await withFixture();
    const policyService = new PolicyService(db);
    const policy = await policyService.create(fixture.organizationId, 'Disabled rule', {
      type: 'cost_gt_cents',
      value: 1,
    });
    await policyService.setActive(fixture.organizationId, policy.id, false);

    const result = await policyService.evaluate(fixture.organizationId, { estimatedCostCents: 100_000 });
    expect(result.requiresApproval).toBe(false);
  });

  it('delete removes a policy, throws NotFoundError for an unknown id', async () => {
    const fixture = await withFixture();
    const policyService = new PolicyService(db);
    const policy = await policyService.create(fixture.organizationId, 'Temp rule', { type: 'cost_gt_cents', value: 1 });

    await policyService.delete(fixture.organizationId, policy.id);
    expect(await policyService.list(fixture.organizationId)).toHaveLength(0);

    await expect(policyService.delete(fixture.organizationId, policy.id)).rejects.toThrow();
  });
});
