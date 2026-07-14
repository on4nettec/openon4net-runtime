import type { FastifyRequest } from 'fastify';
import { RateLimitedError } from '@o2n/governance';
import type { RedisClient } from '../redis.js';

/**
 * Fixed-window counter, one call per request. `scope` is the RateLimitedError
 * identifier (e.g. "agent:<id>", "webhook:<id>") — keys are namespaced by
 * caller-provided `keyPrefix` so different call sites can't collide.
 */
export async function checkFixedWindowRateLimit(
  redis: RedisClient,
  keyPrefix: string,
  limitPerMinute: number,
  scope: string,
): Promise<void> {
  const period = Math.floor(Date.now() / 60_000); // current minute
  const key = `${keyPrefix}:${period}`;

  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 60);
  }

  if (count > limitPerMinute) {
    throw new RateLimitedError(scope);
  }
}

/**
 * Fixed-window counter per docs/spect/03_DATABASE/01-schema-master.md §3
 * (`ratelimit:{agent_id}:{period}`). Scoped to chat routes only, not global —
 * Agent CRUD isn't rate-limited in Sprint 0.
 */
export function createAgentRateLimiter(redis: RedisClient, limitPerMinute: number) {
  return async function checkRateLimit(request: FastifyRequest<{ Params: { id: string } }>): Promise<void> {
    await checkFixedWindowRateLimit(redis, `ratelimit:${request.params.id}`, limitPerMinute, `agent:${request.params.id}`);
  };
}

export interface RateLimitStatus {
  usedThisMinute: number;
  limitPerMinute: number;
  resetsInSeconds: number;
}

/** Read-only — does not increment the counter, safe to poll from the dashboard. */
export async function getRateLimitStatus(
  redis: RedisClient,
  agentId: string,
  limitPerMinute: number,
): Promise<RateLimitStatus> {
  const now = Date.now();
  const period = Math.floor(now / 60_000);
  const key = `ratelimit:${agentId}:${period}`;

  const raw = await redis.get(key);
  const usedThisMinute = raw ? Number(raw) : 0;
  const resetsInSeconds = 60 - Math.floor((now % 60_000) / 1000);

  return { usedThisMinute, limitPerMinute, resetsInSeconds };
}
