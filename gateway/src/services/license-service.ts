import type { ActivationState } from './activation-state.js';

/**
 * RT-028/RT-078 — per docs/spect/02_ARCHITECTURE/02-ai-gateway.md §1.2,
 * paid-plan feature gating. Deliberately the OPPOSITE default of
 * ActivationState.isActivated(): that one defaults `true` for an
 * unconfigured pure self-host (self-host-first is the product's whole
 * point), but a licensed feature like the Managed AI Gateway isn't free
 * just because Control Plane was never configured or is unreachable —
 * only an explicit `true` from a real check-in response unlocks it.
 */
export function hasFeature(activationState: ActivationState, feature: string): boolean {
  return activationState.lastCheckIn?.featureFlags?.[feature] === true;
}

export const PROGRAMMER_AGENT_ROLE = 'programmer';
export const GATED_PLUGIN_CATEGORY = 'devops';
export const MANAGED_AI_GATEWAY_FEATURE = 'managedAiGateway';
