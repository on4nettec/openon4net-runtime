import { randomUUID } from 'node:crypto';
import { AgentScheduleSchema } from '@o2n/shared';
import type { AppContext } from '../context.js';
import { ChatService } from './chat-service.js';

const CHECK_INTERVAL_MS = 30_000;

interface ScheduleCandidateRow {
  id: string;
  organization_id: string;
  schedule: unknown;
}

/**
 * Periodic autonomous agent check-ins (RT-007, agents.schedule — see
 * AgentScheduleSchema). No external cron/job-queue dependency: a single
 * setInterval tick scans for due agents every 30s, which is precise enough
 * for a self-hosted single-instance Runtime deployment. lastRunAt lives
 * inside the schedule JSONB itself (updated before the chat call, not
 * after, so an overlapping/slow tick can't double-fire the same agent).
 */
export function startScheduler(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    runDueSchedules(ctx).catch((err) => {
      console.error('Scheduler tick failed:', err);
    });
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function runDueSchedules(ctx: AppContext): Promise<void> {
  const { rows } = await ctx.db.query<ScheduleCandidateRow>(
    `SELECT id, organization_id, schedule FROM agents
     WHERE status = 'active' AND schedule->>'enabled' = 'true'`,
  );

  const now = Date.now();
  for (const row of rows) {
    const parsed = AgentScheduleSchema.safeParse(row.schedule);
    if (!parsed.success || !parsed.data.enabled || !parsed.data.intervalMinutes || !parsed.data.prompt) continue;

    const { intervalMinutes, prompt, lastRunAt } = parsed.data;
    const lastRunMs = lastRunAt ? new Date(lastRunAt).getTime() : 0;
    if (now - lastRunMs < intervalMinutes * 60_000) continue;

    // Mark before executing, not after — a slow/overlapping chat call must
    // not cause the same agent to fire twice.
    const updatedSchedule = { ...parsed.data, lastRunAt: new Date(now).toISOString() };
    await ctx.db.query(`UPDATE agents SET schedule = $1 WHERE id = $2`, [
      JSON.stringify(updatedSchedule),
      row.id,
    ]);

    const chatService = new ChatService(
      ctx.db,
      ctx.redis,
      ctx.providerConfigService,
      ctx.env,
      ctx.embeddingService,
      ctx.policyService,
    );
    try {
      await chatService.chat({
        organizationId: row.organization_id,
        userId: null, // system-initiated, no human in the loop
        agentId: row.id,
        message: prompt,
        traceId: randomUUID(),
      });
    } catch (err) {
      console.error(`Scheduled run failed for agent ${row.id}:`, err);
    }
  }
}
