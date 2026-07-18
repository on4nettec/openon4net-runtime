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
  // RT-081 — Control Plane's CP-026 seat model: 'personal' allows exactly one
  // Runtime user, 'organizational' allows up to maxUsers (null = unlimited).
  activationType: 'personal' | 'organizational';
  maxUsers: number | null;
  // CP-012 — the org's own opt-in toggle for actually routing LLM calls
  // through the Managed AI Gateway, separate from featureFlags.managedAiGateway
  // (whether the *plan* includes it at all). Not yet consumed by RT-028/
  // RT-078's gating — those check the plan flag only, per 02-ai-gateway.md
  // §1.2's literal "purchased the plan" wording — kept here so this type
  // doesn't silently drift from Platform's actual response shape.
  aiGatewayEnabled: boolean;
  // CP-032 — short-lived (~2h) token proving "a currently-valid activation
  // key checked in recently", replacing the single global static secrets
  // (MARKETPLACE_API_KEY, ...) Runtime previously had to hold directly for
  // Marketplace/Memory access. See CP-034's Platform-side proxy routes and
  // marketplace-client.ts's use of it (RT-093).
  securityToken: string;
}

/**
 * T-CP-007 — Runtime side of Control Plane's activation-key system
 * (apps/openon4net-control-plane/gateway/src/routes/activation.ts).
 * Best-effort, same "never throws" contract as EmbeddingService.embed() — a
 * Control-Plane outage must never block Runtime's own operation. Returns
 * null when unconfigured (no CONTROL_PLANE_URL and no key available — pure
 * self-host) or on any network/parse/non-2xx failure.
 *
 * RT-092 — `activationKeyOverride` lets a caller check in with a key that
 * isn't (yet) persisted anywhere: the first-run /v1/activation/configure
 * route validates a freshly-typed code this way *before* saving it (so an
 * invalid code is never written to activation_config), while the normal
 * scheduler tick omits it and this function falls back to whichever key
 * ActivationConfigService/env.ACTIVATION_KEY actually resolved.
 */
export async function checkIn(env: Env, activationKeyOverride?: string): Promise<CheckInResult | null> {
  const activationKey = activationKeyOverride ?? env.ACTIVATION_KEY;
  if (!env.CONTROL_PLANE_URL || !activationKey) return null;
  try {
    const response = await fetch(`${env.CONTROL_PLANE_URL}/activation/check-in`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${activationKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    return (await response.json()) as CheckInResult;
  } catch (err) {
    console.warn('Control Plane activation check-in failed:', err);
    return null;
  }
}
