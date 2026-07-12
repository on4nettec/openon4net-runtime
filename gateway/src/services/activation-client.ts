import type { Env } from '../env.js';

export interface CheckInResult {
  organizationId: string;
  organizationName: string;
  plan: string;
  status: string;
  policy: {
    allowedModels: string[];
    allowedProviders: string[];
    governanceThresholds: { approvalThresholdCents: number };
  };
  featureFlags: Record<string, boolean>;
}

/**
 * T-CP-007 — Runtime side of Control Plane's activation-key system
 * (apps/openon4net-control-plane/gateway/src/routes/activation.ts).
 * Best-effort, same "never throws" contract as EmbeddingService.embed() — a
 * Control-Plane outage must never block Runtime's own operation. Returns
 * null when unconfigured (no CONTROL_PLANE_URL/ACTIVATION_KEY — pure
 * self-host) or on any network/parse/non-2xx failure.
 */
export async function checkIn(env: Env): Promise<CheckInResult | null> {
  if (!env.CONTROL_PLANE_URL || !env.ACTIVATION_KEY) return null;
  try {
    const response = await fetch(`${env.CONTROL_PLANE_URL}/activation/check-in`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.ACTIVATION_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as CheckInResult;
  } catch (err) {
    console.warn('Control Plane activation check-in failed:', err);
    return null;
  }
}
