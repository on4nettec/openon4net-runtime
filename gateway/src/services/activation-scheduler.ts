import type { AppContext } from '../context.js';
import { checkIn } from './activation-client.js';
import { OrgService } from './org-service.js';

const CHECK_INTERVAL_MS = 60 * 60_000; // hourly

/**
 * Same setInterval + disposer shape as services/scheduler.ts. Checks in once
 * immediately on boot, then hourly.
 *
 * RT-081 — a successful check-in also persists activationType/maxUsers onto
 * the org row (updateActivationInfo), so UserService.create()/
 * InvitationService.accept()'s seat-cap check has fresh data even when
 * Control Plane is unreachable at the moment a user is actually added — it
 * enforces against the last-known values, not a live call per request. The
 * persistence step stays inside the same best-effort chain as
 * recordSuccess() — a slow/failing DB write here must not turn into an
 * unhandled rejection that crashes the scheduler tick.
 */
export function startActivationScheduler(ctx: AppContext): () => void {
  const orgService = new OrgService(ctx.db);
  const tick = (): void => {
    checkIn(ctx.env)
      .then(async (result) => {
        if (!result) return;
        ctx.activationState.recordSuccess(result);
        await orgService.updateActivationInfo(result.organizationId, result.activationType, result.maxUsers);
      })
      .catch((err: unknown) => {
        console.error('Activation scheduler tick failed:', err);
      });
  };
  tick();
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
