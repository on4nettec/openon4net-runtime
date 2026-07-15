import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.js';
import { healthCheckStatus } from '../observability/metrics.js';

export interface HealthCheckResult {
  status: 'ok' | 'degraded';
  failing: string[];
}

/**
 * RT-070 — beyond "the process is up," a k8s readiness probe needs to know
 * the two things this gateway can't serve traffic without: Postgres and
 * Redis. Checked in parallel, failing lists which one(s) are down. Exported
 * separately from the route (health.test.ts) so it's testable against real
 * Postgres/Redis — no route-level HTTP test needed for this.
 */
export async function checkHealth(ctx: Pick<AppContext, 'db' | 'redis'>): Promise<HealthCheckResult> {
  const [dbResult, redisResult] = await Promise.allSettled([ctx.db.query('SELECT 1'), ctx.redis.ping()]);

  const failing: string[] = [];
  if (dbResult.status === 'rejected') failing.push('database');
  if (redisResult.status === 'rejected') failing.push('redis');

  return { status: failing.length > 0 ? 'degraded' : 'ok', failing };
}

export function registerHealthRoute(app: FastifyInstance, ctx: AppContext): void {
  app.get('/health', async (request, reply) => {
    const result = await checkHealth(ctx);
    healthCheckStatus.set(result.status === 'ok' ? 1 : 0);
    if (result.status === 'degraded') {
      reply.status(503);
    }
    return result;
  });
}
