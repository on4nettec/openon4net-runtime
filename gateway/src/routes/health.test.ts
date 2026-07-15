import { describe, expect, it } from 'vitest';
import { createDb } from '../db.js';
import { createTestDb } from '../test-support/db.js';
import { createRedis } from '../redis.js';
import { checkHealth } from './health.js';

describe('checkHealth', () => {
  it('returns ok when both Postgres and Redis are reachable', async () => {
    const db = createTestDb();
    const redis = createRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    try {
      const result = await checkHealth({ db, redis });
      expect(result).toEqual({ status: 'ok', failing: [] });
    } finally {
      await db.end();
      redis.disconnect();
    }
  });

  it('reports "database" as failing when Postgres is unreachable', async () => {
    const db = createDb('postgres://baduser:badpass@127.0.0.1:1/nonexistent');
    const redis = createRedis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    try {
      const result = await checkHealth({ db, redis });
      expect(result.status).toBe('degraded');
      expect(result.failing).toContain('database');
      expect(result.failing).not.toContain('redis');
    } finally {
      await db.end().catch(() => undefined);
      redis.disconnect();
    }
  });

  it('reports "redis" as failing when Redis is unreachable', async () => {
    const db = createTestDb();
    // maxRetriesPerRequest: 0 — otherwise ioredis retries for a while before
    // the ping actually rejects, making this test slow instead of fast-failing.
    const redis = createRedis('redis://127.0.0.1:1');
    redis.options.maxRetriesPerRequest = 0;
    try {
      const result = await checkHealth({ db, redis });
      expect(result.status).toBe('degraded');
      expect(result.failing).toContain('redis');
      expect(result.failing).not.toContain('database');
    } finally {
      await db.end();
      redis.disconnect();
    }
  });
});
