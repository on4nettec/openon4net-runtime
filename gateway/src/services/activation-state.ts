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
  // RT-092 — no longer readonly: a DB-configured activation key (set via
  // POST /v1/activation/configure, after this process already started) can
  // make an initially-unconfigured deployment configured without a restart.
  private configured: boolean;

  constructor(env: Env) {
    this.configured = Boolean(env.CONTROL_PLANE_URL && env.ACTIVATION_KEY);
  }

  recordSuccess(result: CheckInResult): void {
    this.lastSuccessAt = Date.now();
    this.lastResult = result;
  }

  /** RT-092 — called once activation-scheduler.ts confirms a key exists (env or DB), or right after a successful manual /v1/activation/configure. Idempotent. */
  markConfigured(): void {
    this.configured = true;
  }

  isConfigured(): boolean {
    return this.configured;
  }

  isActivated(): boolean {
    if (!this.configured) return true;
    if (this.lastSuccessAt === null) return false;
    return Date.now() - this.lastSuccessAt < GRACE_MS;
  }

  get lastCheckIn(): CheckInResult | null {
    return this.lastResult;
  }

  /** RT-093 — the short-lived proxy token from the most recent successful check-in, if any (null before the first successful check-in, or when unconfigured). */
  get securityToken(): string | null {
    return this.lastResult?.securityToken ?? null;
  }
}
