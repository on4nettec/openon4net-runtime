import type { AppContext } from '../context.js';
import { detectSkillPatterns } from './skill-pattern-detector.js';

// Analytical, not time-critical — a much longer tick than services/scheduler.ts's 30s.
const CHECK_INTERVAL_MS = 10 * 60_000;

/**
 * Periodic Auto-Skill Detection sweep (docs/spect/02_ARCHITECTURE/
 * 03-skill-engine.md §7). Same setInterval + disposer shape as
 * services/scheduler.ts, reused rather than reinvented.
 */
export function startSkillProposalScheduler(ctx: AppContext): () => void {
  const timer = setInterval(() => {
    detectSkillPatterns(ctx.db).catch((err: unknown) => {
      console.error('Skill proposal scheduler tick failed:', err);
    });
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}
