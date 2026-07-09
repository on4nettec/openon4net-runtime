import { getProvider } from '@o2n/llm-providers';
import { loadEnv } from './env.js';
import { createDb } from './db.js';
import { createRedis } from './redis.js';
import { buildApp } from './app.js';
import type { AppContext } from './context.js';

async function main(): Promise<void> {
  const env = loadEnv();

  const ctx: AppContext = {
    env,
    db: createDb(env.DATABASE_URL),
    redis: createRedis(env.REDIS_URL),
    llmProvider: getProvider(env.LLM_PROVIDER, env.LLM_API_KEY, env.LLM_BASE_URL),
  };

  const app = await buildApp(ctx);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err: unknown) => {
  console.error('Fatal error starting gateway:', err);
  process.exit(1);
});
