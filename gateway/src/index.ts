import { loadEnv } from './env.js';
import { createDb } from './db.js';
import { createRedis } from './redis.js';
import { buildApp } from './app.js';
import { runMigrations } from './migrator.js';
import { ProviderConfigService } from './services/provider-config-service.js';
import { PermissionService } from './services/permission-service.js';
import { EmbeddingService } from './services/embedding-service.js';
import { PolicyService } from './services/policy-service.js';
import { startScheduler } from './services/scheduler.js';
import { startSkillProposalScheduler } from './services/skill-proposal-scheduler.js';
import { ActivationState } from './services/activation-state.js';
import { startActivationScheduler } from './services/activation-scheduler.js';
import type { AppContext } from './context.js';

async function main(): Promise<void> {
  const env = loadEnv();

  // RT-029: fail-fast is intentional here — a half-migrated schema must not
  // serve traffic. Disable via DB_AUTO_MIGRATE=false for environments where
  // migrations are reviewed/applied out-of-band (`pnpm run migrate` covers
  // that manual path); see scripts/migrate.mjs.
  if (env.DB_AUTO_MIGRATE) {
    await runMigrations(env.DATABASE_URL, (msg) => console.log(`[migrate] ${msg}`));
  }

  const db = createDb(env.DATABASE_URL);

  const ctx: AppContext = {
    env,
    db,
    redis: createRedis(env.REDIS_URL),
    providerConfigService: new ProviderConfigService(db, env),
    permissionService: new PermissionService(db),
    embeddingService: new EmbeddingService(env),
    policyService: new PolicyService(db),
    activationState: new ActivationState(env),
  };

  const app = await buildApp(ctx);
  startScheduler(ctx);
  startSkillProposalScheduler(ctx);
  startActivationScheduler(ctx);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  console.error('Fatal error starting gateway:', err);
  process.exit(1);
});
