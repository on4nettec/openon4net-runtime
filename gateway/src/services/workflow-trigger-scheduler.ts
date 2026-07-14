import { WorkflowTriggerSchema } from '@o2n/shared';
import type { AppContext } from '../context.js';
import { WorkflowExecutor } from './workflow-executor.js';

const CHECK_INTERVAL_MS = 30_000; // same cadence as scheduler.ts's agent schedules

interface WorkflowCandidateRow {
  id: string;
  organization_id: string;
  trigger: unknown;
}

/**
 * Scheduled workflow triggers (RT-066): {type:'scheduled', intervalMinutes}
 * reuses agents.schedule's exact interval shape (no cron library), and
 * lastRunAt lives inside the trigger JSONB itself, updated before the run
 * starts — same double-fire guard as scheduler.ts. Webhook-triggered runs
 * need no separate code here; routes/webhooks.ts's target_type:'workflow'
 * handler already covers that path directly.
 */
export function startWorkflowTriggerScheduler(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    runDueWorkflows(ctx).catch((err) => {
      console.error('Workflow trigger scheduler tick failed:', err);
    });
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function runDueWorkflows(ctx: AppContext): Promise<void> {
  const { rows } = await ctx.db.query<WorkflowCandidateRow>(
    `SELECT id, organization_id, trigger FROM workflows WHERE status = 'active' AND trigger->>'type' = 'scheduled'`,
  );

  const now = Date.now();
  for (const row of rows) {
    const parsed = WorkflowTriggerSchema.safeParse(row.trigger);
    if (!parsed.success || parsed.data.type !== 'scheduled') continue;

    const lastRunMs = parsed.data.lastRunAt ? new Date(parsed.data.lastRunAt).getTime() : 0;
    if (now - lastRunMs < parsed.data.intervalMinutes * 60_000) continue;

    const updatedTrigger = { ...parsed.data, lastRunAt: new Date(now).toISOString() };
    await ctx.db.query(`UPDATE workflows SET trigger = $1 WHERE id = $2`, [JSON.stringify(updatedTrigger), row.id]);

    try {
      await new WorkflowExecutor(ctx).start(row.organization_id, row.id, null);
    } catch (err) {
      console.error(`Scheduled workflow run failed for workflow ${row.id}:`, err);
    }
  }
}
