import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  DEV_API_KEY: z.string().min(1),
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'deepseek', 'ollama']),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  // Overrides the default base URL for openai/deepseek/ollama (all share one
  // OpenAI-compatible adapter — see packages/llm-providers/src/registry.ts).
  // Leave unset to use each provider's default; irrelevant for anthropic.
  LLM_BASE_URL: z.string().url().optional(),
  APPROVAL_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(2000),
  SHORT_MEMORY_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(100),
  // Optional: the telegram-send tool 400s with a clear message if unset,
  // rather than every other route failing validation at startup.
  TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
  // AES-256-GCM master key for per-org llm_configs.api_key_encrypted (see
  // gateway/src/lib/crypto.ts). Generate with `openssl rand -hex 32`.
  CONFIG_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-char hex string (32 bytes)'),
  // Optional: enables semantic memory search (migrations/0008_vector_search.sql).
  // Only takes effect when LLM_PROVIDER is openai or ollama — see
  // packages/llm-providers/src/embedding.ts for why. Left unset, memory
  // search silently falls back to the plain ILIKE search it always had.
  EMBEDDING_MODEL: z.string().min(1).optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
