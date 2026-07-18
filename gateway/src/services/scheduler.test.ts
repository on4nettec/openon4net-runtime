import { describe, it, expect } from 'vitest';
import type { AgentSchedule } from '@o2n/shared';
import { isDue } from './scheduler.js';

describe('isDue (RT-088)', () => {
  const UTC = 'UTC';

  describe('legacy interval behavior (pre-RT-088 schedules, no `timing`/`target`)', () => {
    it('is not due before intervalMinutes has elapsed since lastRunAt', () => {
      const schedule: AgentSchedule = { enabled: true, intervalMinutes: 60, prompt: 'hi', lastRunAt: new Date(Date.now() - 30 * 60_000).toISOString() };
      expect(isDue(schedule, Date.now(), UTC)).toBe(false);
    });

    it('is due once intervalMinutes has elapsed since lastRunAt', () => {
      const schedule: AgentSchedule = { enabled: true, intervalMinutes: 60, prompt: 'hi', lastRunAt: new Date(Date.now() - 61 * 60_000).toISOString() };
      expect(isDue(schedule, Date.now(), UTC)).toBe(true);
    });

    it('is due immediately when there is no lastRunAt at all (never run before)', () => {
      const schedule: AgentSchedule = { enabled: true, intervalMinutes: 60, prompt: 'hi' };
      expect(isDue(schedule, Date.now(), UTC)).toBe(true);
    });
  });

  describe('RT-088 — timing.type === "interval" (same semantics as legacy, new shape)', () => {
    it('behaves identically to the legacy intervalMinutes field', () => {
      const schedule: AgentSchedule = {
        enabled: true,
        timing: { type: 'interval', intervalMinutes: 60 },
        target: { type: 'chat', prompt: 'hi' },
        lastRunAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      };
      expect(isDue(schedule, Date.now(), UTC)).toBe(false);
    });
  });

  describe('RT-088 — timing.type === "cron"', () => {
    it('is due when the current UTC minute/hour match, and lastRunAt is old enough', () => {
      const now = new Date('2026-07-18T09:00:00.000Z').getTime();
      const schedule: AgentSchedule = {
        enabled: true,
        timing: { type: 'cron', minute: 0, hour: 9 },
        target: { type: 'chat', prompt: 'daily check-in' },
      };
      expect(isDue(schedule, now, UTC)).toBe(true);
    });

    it('is not due when the minute does not match', () => {
      const now = new Date('2026-07-18T09:05:00.000Z').getTime();
      const schedule: AgentSchedule = {
        enabled: true,
        timing: { type: 'cron', minute: 0, hour: 9 },
        target: { type: 'chat', prompt: 'daily check-in' },
      };
      expect(isDue(schedule, now, UTC)).toBe(false);
    });

    it('omitting `hour` means "every hour" — only minute is checked', () => {
      const now = new Date('2026-07-18T14:30:00.000Z').getTime();
      const schedule: AgentSchedule = {
        enabled: true,
        timing: { type: 'cron', minute: 30 },
        target: { type: 'chat', prompt: 'hourly check-in' },
      };
      expect(isDue(schedule, now, UTC)).toBe(true);
    });

    it('respects daysOfWeek — only fires on the listed weekday(s)', () => {
      // 2026-07-18 is a Saturday (day 6).
      const saturday = new Date('2026-07-18T09:00:00.000Z').getTime();
      const scheduleForMonday: AgentSchedule = {
        enabled: true,
        timing: { type: 'cron', minute: 0, hour: 9, daysOfWeek: [1] }, // Monday only
        target: { type: 'chat', prompt: 'weekly check-in' },
      };
      expect(isDue(scheduleForMonday, saturday, UTC)).toBe(false);

      const scheduleForSaturday: AgentSchedule = {
        enabled: true,
        timing: { type: 'cron', minute: 0, hour: 9, daysOfWeek: [6] }, // Saturday
        target: { type: 'chat', prompt: 'weekly check-in' },
      };
      expect(isDue(scheduleForSaturday, saturday, UTC)).toBe(true);
    });

    it('respects dayOfMonth — only fires on that day of the month', () => {
      const the1st = new Date('2026-07-01T00:00:00.000Z').getTime();
      const the15th = new Date('2026-07-15T00:00:00.000Z').getTime();
      const schedule: AgentSchedule = {
        enabled: true,
        timing: { type: 'cron', minute: 0, hour: 0, dayOfMonth: 1 },
        target: { type: 'chat', prompt: 'monthly check-in' },
      };
      expect(isDue(schedule, the1st, UTC)).toBe(true);
      expect(isDue(schedule, the15th, UTC)).toBe(false);
    });

    it('does not re-fire within the ~60s minute-match window even if the tick lands twice inside it', () => {
      const now = new Date('2026-07-18T09:00:00.000Z').getTime();
      const schedule: AgentSchedule = {
        enabled: true,
        timing: { type: 'cron', minute: 0, hour: 9 },
        target: { type: 'chat', prompt: 'daily check-in' },
        lastRunAt: new Date(now - 20_000).toISOString(), // fired 20s ago, same matching minute
      };
      expect(isDue(schedule, now, UTC)).toBe(false);
    });

    it('correctly evaluates the pattern in a non-UTC organization timezone', () => {
      // 09:00 in Asia/Tehran (UTC+03:30) is 05:30 UTC.
      const now = new Date('2026-07-18T05:30:00.000Z').getTime();
      const schedule: AgentSchedule = {
        enabled: true,
        timing: { type: 'cron', minute: 0, hour: 9 },
        target: { type: 'chat', prompt: 'daily check-in, Tehran time' },
      };
      expect(isDue(schedule, now, 'Asia/Tehran')).toBe(true);
      expect(isDue(schedule, now, 'UTC')).toBe(false);
    });
  });

  describe('nothing configured to run / nothing configured to run it on', () => {
    it('is never due when enabled but neither target/prompt nor timing/intervalMinutes is set', () => {
      const schedule: AgentSchedule = { enabled: true };
      expect(isDue(schedule, Date.now(), UTC)).toBe(false);
    });
  });
});
