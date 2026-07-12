import type { Env } from '../env.js';

/**
 * A minimal, fully-valid Env object built directly (not via loadEnv(), which
 * would require a real .env file with every auth-method field satisfied and
 * isn't guaranteed to exist in CI) — same approach used by the Memory
 * service's test-support/context.ts earlier this session.
 */
export function createTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    PORT: 4000,
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://on4netdbuser:Password_123@localhost:5432/o2n',
    REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
    JWT_SECRET: 'test-jwt-secret',
    DB_AUTO_MIGRATE: false,
    LLM_PROVIDER: 'ollama',
    LLM_API_KEY: 'ollama',
    LLM_MODEL: 'test-model',
    APPROVAL_THRESHOLD_CENTS: 2000,
    SHORT_MEMORY_TTL_SECONDS: 3600,
    RATE_LIMIT_PER_MINUTE: 100,
    CONFIG_ENCRYPTION_KEY: 'cf408c7e653f8ff8559e24764039a5823923508c7cac72619b5bbb4cfc0562c0',
    NODE_ENV: 'test',
    AUTH_METHODS_ENABLED: 'dev_api_key',
    AUTH_ALLOW_DEV_METHODS: true,
    DEV_API_KEY: 'test-dev-api-key',
    PASSWORD_HASHER: 'argon2id',
    PASSWORD_MIN_LENGTH: 10,
    SMTP_SECURE: false,
    authMethods: ['dev_api_key'],
    oauthProviders: [],
    ...overrides,
  };
}
