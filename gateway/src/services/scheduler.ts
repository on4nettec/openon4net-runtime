import { randomUUID } from 'node:crypto';
import { AgentScheduleSchema, type AgentSchedule, type AgentScheduleTarget, type AgentScheduleTiming } from '@o2n/shared';
import type { AppContext } from '../context.js';
import { ChatService } from './chat-service.js';
import { executeTool } from './tool-dispatcher.js';
import { executeSkill } from './skill-executor.js';
import { WorkflowExecutor } from './workflow-executor.js';

const CHECK_INTERVAL_MS = 30_000;

/**
 * RT-088 — a cron match is "true" for the whole ~60s minute window (2 ticks
 * at CHECK_INTERVAL_MS cadence), so this guards against firing on both
 * ticks within that window. Legacy interval-based schedules don't need
 * this — their own `intervalMinutes` gate already prevents double-firing.
 */
const MIN_CRON_RE_FIRE_GAP_MS = 55_000;

interface ScheduleCandidateRow {
  id: string;
  organization_id: string;
  schedule: unknown;
  timezone: string;
}

/**
 * Periodic autonomous agent check-ins (RT-007, agents.schedule — see
 * AgentScheduleSchema). No external cron/job-queue dependency: a single
 * setInterval tick scans for due agents every 30s, which is precise enough
 * for a self-hosted single-instance Runtime deployment. lastRunAt lives
 * inside the schedule JSONB itself (updated before the target runs, not
 * after, so an overlapping/slow run can't double-fire the same agent).
 */
export function startScheduler(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    runDueSchedules(ctx).catch((err) => {
      console.error('Scheduler tick failed:', err);
    });
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

/** RT-088 — the organization's local minute/hour/day-of-week/day-of-month, for evaluating a `timing.type === 'cron'` pattern. hourCycle:'h23' pins the hour to a plain 0-23 range regardless of locale defaults. */
function getOrgLocalParts(now: number, timezone: string): { minute: number; hour: number; dayOfWeek: number; dayOfMonth: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: 'numeric',
    minute: 'numeric',
    day: 'numeric',
    weekday: 'short',
  });
  const parts = formatter.formatToParts(new Date(now));
  const get = (type: string): string | undefined => parts.find((p) => p.type === type)?.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    minute: Number(get('minute')),
    hour: Number(get('hour')),
    dayOfWeek: weekdayMap[get('weekday') ?? 'Sun'] ?? 0,
    dayOfMonth: Number(get('day')),
  };
}

function isDueByCron(timing: Extract<AgentScheduleTiming, { type: 'cron' }>, now: number, timezone: string): boolean {
  const local = getOrgLocalParts(now, timezone);
  if (local.minute !== timing.minute) return false;
  if (timing.hour !== undefined && local.hour !== timing.hour) return false;
  if (timing.daysOfWeek !== undefined && !timing.daysOfWeek.includes(local.dayOfWeek)) return false;
  if (timing.dayOfMonth !== undefined && local.dayOfMonth !== timing.dayOfMonth) return false;
  return true;
}

/**
 * RT-088 — dispatches on `timing` when set, else falls back to the legacy
 * flat `intervalMinutes` field (pre-RT-088 schedules, unaffected). Exported
 * for scheduler.test.ts — this is the one deterministic, side-effect-free
 * piece of an otherwise timer-driven module (matching this codebase's
 * existing convention of not unit-testing the timer/dispatch scaffolding
 * itself, only the logic that decides "is this due right now").
 */
export function isDue(schedule: AgentSchedule, now: number, timezone: string): boolean {
  const lastRunMs = schedule.lastRunAt ? new Date(schedule.lastRunAt).getTime() : 0;

  if (schedule.timing?.type === 'cron') {
    if (now - lastRunMs < MIN_CRON_RE_FIRE_GAP_MS) return false;
    return isDueByCron(schedule.timing, now, timezone);
  }

  const intervalMinutes = schedule.timing?.type === 'interval' ? schedule.timing.intervalMinutes : schedule.intervalMinutes;
  if (!intervalMinutes) return false;
  return now - lastRunMs >= intervalMinutes * 60_000;
}

/** RT-088 — dispatches on `target` when set, else falls back to the legacy flat `prompt` field (a plain chat message, pre-RT-088 behavior). */
async function executeTarget(
  ctx: AppContext,
  target: AgentScheduleTarget | undefined,
  legacyPrompt: string | undefined,
  organizationId: string,
  agentId: string,
): Promise<void> {
  const effective: AgentScheduleTarget | undefined = target ?? (legacyPrompt ? { type: 'chat', prompt: legacyPrompt } : undefined);
  if (!effective) return;

  if (effective.type === 'chat') {
    const chatService = new ChatService(
      ctx.db,
      ctx.redis,
      ctx.providerConfigService,
      ctx.env,
      ctx.embeddingService,
      ctx.policyService,
    );
    await chatService.chat({
      organizationId,
      userId: null, // system-initiated, no human in the loop
      agentId,
      message: effective.prompt,
      traceId: randomUUID(),
    });
  } else if (effective.type === 'tool') {
    await executeTool({ id: randomUUID(), type: 'tool', tool: effective.tool, params: effective.params }, ctx.env);
  } else if (effective.type === 'skill') {
    await executeSkill(ctx.db, ctx.env, organizationId, agentId, effective.skillId, effective.params);
  } else if (effective.type === 'workflow') {
    await new WorkflowExecutor(ctx).start(organizationId, effective.workflowId, null);
  }
}

async function runDueSchedules(ctx: AppContext): Promise<void> {
  const { rows } = await ctx.db.query<ScheduleCandidateRow>(
    `SELECT a.id, a.organization_id, a.schedule, o.timezone
     FROM agents a
     JOIN organizations o ON o.id = a.organization_id
     WHERE a.status = 'active' AND a.schedule->>'enabled' = 'true'`,
  );

  const now = Date.now();
  for (const row of rows) {
    const parsed = AgentScheduleSchema.safeParse(row.schedule);
    if (!parsed.success || !parsed.data.enabled) continue;
    const schedule = parsed.data;

    // Nothing configured to run, or nothing configured to run it on — same
    // skip condition as before RT-088, just checking either shape.
    if (schedule.target === undefined && !schedule.prompt) continue;
    if (schedule.timing === undefined && !schedule.intervalMinutes) continue;

    if (!isDue(schedule, now, row.timezone)) continue;

    // Mark before executing, not after — a slow/overlapping run must not
    // cause the same agent to fire twice.
    const updatedSchedule = { ...schedule, lastRunAt: new Date(now).toISOString() };
    await ctx.db.query(`UPDATE agents SET schedule = $1 WHERE id = $2`, [
      JSON.stringify(updatedSchedule),
      row.id,
    ]);

    try {
      await executeTarget(ctx, schedule.target, schedule.prompt, row.organization_id, row.id);
    } catch (err) {
      console.error(`Scheduled run failed for agent ${row.id}:`, err);
    }
  }
}
