import { describe, it, expect } from 'vitest';
import { createTestEnv } from '../test-support/env.js';
import { ActivationState } from './activation-state.js';
import type { CheckInResult } from './activation-client.js';
import { hasFeature, MANAGED_AI_GATEWAY_FEATURE } from './license-service.js';

function fakeCheckIn(featureFlags: Record<string, boolean>): CheckInResult {
  return {
    organizationId: 'org-1',
    organizationName: 'Test Org',
    plan: 'business',
    status: 'active',
    policy: { allowedModels: [], allowedProviders: [], governanceThresholds: { approvalThresholdCents: 2000 } },
    featureFlags,
    activationType: 'organizational',
    maxUsers: null,
    aiGatewayEnabled: false,
  };
}

describe('license-service (RT-028/RT-078)', () => {
  it('defaults to false when no check-in has ever succeeded', () => {
    const state = new ActivationState(createTestEnv());
    expect(hasFeature(state, MANAGED_AI_GATEWAY_FEATURE)).toBe(false);
  });

  it('returns true when the last check-in explicitly granted the feature', () => {
    const state = new ActivationState(createTestEnv());
    state.recordSuccess(fakeCheckIn({ [MANAGED_AI_GATEWAY_FEATURE]: true }));
    expect(hasFeature(state, MANAGED_AI_GATEWAY_FEATURE)).toBe(true);
  });

  it('returns false when the last check-in explicitly denied the feature', () => {
    const state = new ActivationState(createTestEnv());
    state.recordSuccess(fakeCheckIn({ [MANAGED_AI_GATEWAY_FEATURE]: false }));
    expect(hasFeature(state, MANAGED_AI_GATEWAY_FEATURE)).toBe(false);
  });

  it('returns false for a feature key absent from featureFlags entirely (not just falsy)', () => {
    const state = new ActivationState(createTestEnv());
    state.recordSuccess(fakeCheckIn({ someOtherFeature: true }));
    expect(hasFeature(state, MANAGED_AI_GATEWAY_FEATURE)).toBe(false);
  });
});
