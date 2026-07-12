import type { Env } from '../env.js';
import type { CheckInResult } from './activation-client.js';

const GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Caches the outcome of the most recent successful activation check-in.
 * `isActivated()` defaults `true` when Runtime has no Control-Plane
 * integration configured at all (pure self-host, no CONTROL_PLANE_URL/
 * ACTIVATION_KEY) — self-host-first is this project's stated MVP target, so
 * an unconfigured Runtime must never read as "unactivated." Once a key IS
 * configured, `isActivated()` flips false after 24h with no successful
 * check-in — a grace window tolerating transient Control-Plane downtime
 * rather than an instant lockout.
 */
export class ActivationState {
  private lastSuccessAt: number | null = null;
  private lastResult: CheckInResult | null = null;
  private readonly configured: boolean;

  constructor(env: Env) {
    this.configured = Boolean(env.CONTROL_PLANE_URL && env.ACTIVATION_KEY);
  }

  recordSuccess(result: CheckInResult): void {
    this.lastSuccessAt = Date.now();
    this.lastResult = result;
  }

  isActivated(): boolean {
    if (!this.configured) return true;
    if (this.lastSuccessAt === null) return false;
    return Date.now() - this.lastSuccessAt < GRACE_MS;
  }

  get lastCheckIn(): CheckInResult | null {
    return this.lastResult;
  }
}
