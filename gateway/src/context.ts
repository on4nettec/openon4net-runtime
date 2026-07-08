import type { Env } from './env.js';
import type { Db } from './db.js';
import type { RedisClient } from './redis.js';
import type { LlmProvider } from '@o2n/llm-providers';

export interface AppContext {
  env: Env;
  db: Db;
  redis: RedisClient;
  llmProvider: LlmProvider;
}
