import type { AppContext } from '../context.js';
import { checkIn } from './activation-client.js';

const CHECK_INTERVAL_MS = 60 * 60_000; // hourly

/** Same setInterval + disposer shape as services/scheduler.ts. Checks in once immediately on boot, then hourly. */
export function startActivationScheduler(ctx: AppContext): () => void {
  const tick = (): void => {
    checkIn(ctx.env)
      .then((result) => {
        if (result) ctx.activationState.recordSuccess(result);
      })
      .catch((err: unknown) => {
        console.error('Activation scheduler tick failed:', err);
      });
  };
  tick();
  const timer = setInterval(tick, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
