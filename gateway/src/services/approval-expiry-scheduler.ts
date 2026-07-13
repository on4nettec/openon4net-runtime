import type { AppContext } from '../context.js';
import { ApprovalService } from './approval-service.js';

const CHECK_INTERVAL_MS = 5 * 60_000; // 5 minutes — approvals aren't as time-sensitive as agent schedules (30s tick)

/**
 * Sweeps approval_queue for entries still `pending` past their `expires_at`
 * and marks them `expired` — see services/approval-service.ts's `expireStale()`
 * and chat-service.ts's `enqueueApproval()` (the only current writer of a
 * non-null expires_at). Same setInterval+disposer shape as scheduler.ts,
 * skill-proposal-scheduler.ts, and activation-scheduler.ts.
 */
export function startApprovalExpiryScheduler(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    new ApprovalService(ctx.db).expireStale().catch((err) => {
      console.error('Approval expiry sweep failed:', err);
    });
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
