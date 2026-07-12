import type { Env } from '../env.js';
import type { AppContext } from '../context.js';
import { createRedis } from '../redis.js';
import { ProviderConfigService } from '../services/provider-config-service.js';
import { PermissionService } from '../services/permission-service.js';
import { EmbeddingService } from '../services/embedding-service.js';
import { PolicyService } from '../services/policy-service.js';
import { createTestDb } from './db.js';
import { createTestEnv } from './env.js';

/** Real Postgres + real (lazy-connecting) Redis client — no mocks. Only `env`/`db` are actually exercised by the skill-engine tests; the rest are cheap, real instances satisfying AppContext's shape. */
export function createTestContext(envOverrides: Partial<Env> = {}): AppContext {
  const env = createTestEnv(envOverrides);
  const db = createTestDb();
  return {
    env,
    db,
    redis: createRedis(env.REDIS_URL),
    providerConfigService: new ProviderConfigService(db, env),
    permissionService: new PermissionService(db),
    embeddingService: new EmbeddingService(env),
    policyService: new PolicyService(db),
  };
}
