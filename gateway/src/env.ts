import { z } from 'zod';

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  DEV_API_KEY: z.string().min(1),
  LLM_PROVIDER: z.enum(['anthropic', 'openai']),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().min(1),
  APPROVAL_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(2000),
  SHORT_MEMORY_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(100),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  return parsed.data;
}
