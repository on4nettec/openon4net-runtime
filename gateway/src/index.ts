import { loadEnv } from './env.js';
import { createDb } from './db.js';
import { createRedis } from './redis.js';
import { buildApp } from './app.js';
import { ProviderConfigService } from './services/provider-config-service.js';
import { PermissionService } from './services/permission-service.js';
import { EmbeddingService } from './services/embedding-service.js';
import { PolicyService } from './services/policy-service.js';
import { startScheduler } from './services/scheduler.js';
import type { AppContext } from './context.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const db = createDb(env.DATABASE_URL);

  const ctx: AppContext = {
    env,
    db,
    redis: createRedis(env.REDIS_URL),
    providerConfigService: new ProviderConfigService(db, env),
    permissionService: new PermissionService(db),
    embeddingService: new EmbeddingService(env),
    policyService: new PolicyService(db),
  };

  const app = await buildApp(ctx);
  startScheduler(ctx);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  console.error('Fatal error starting gateway:', err);
  process.exit(1);
});
