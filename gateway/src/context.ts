import type { Env } from './env.js';
import type { Db } from './db.js';
import type { RedisClient } from './redis.js';
import type { ProviderConfigService } from './services/provider-config-service.js';

export interface AppContext {
  env: Env;
  db: Db;
  redis: RedisClient;
  providerConfigService: ProviderConfigService;
}
