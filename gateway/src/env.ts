import { z } from 'zod';

const AUTH_METHOD_VALUES = ['password', 'magic_link', 'oauth', 'dev_api_key', 'oidc', 'saml'] as const;

/** Comma-separated env value -> array, trimmed, empty string -> []. */
function csv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * z.coerce.boolean() is a footgun for env vars: it just calls Boolean(value),
 * so the *string* "false" (non-empty) coerces to `true`. That's silently
 * catastrophic for a safety flag like AUTH_ALLOW_DEV_METHODS — an operator
 * writing AUTH_ALLOW_DEV_METHODS=false would actually enable it. This parses
 * "true"/"false" literally instead.
 */
function boolEnv(defaultValue: boolean) {
  return z.preprocess((v) => {
    if (v === undefined) return defaultValue;
    if (typeof v === 'string') return v === 'true';
    return v;
  }, z.boolean());
}

const EnvSchema = z
  .object({
    PORT: z.coerce.number().int().positive().default(4000),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    JWT_SECRET: z.string().min(1),
    // RT-029: applies migrations/*.sql on every startup (tracked in
    // schema_migrations, advisory-locked — see scripts/migrate.mjs).
    // Disable for environments where migrations must be reviewed/applied
    // out-of-band (`pnpm run migrate` covers that manual path).
    DB_AUTO_MIGRATE: boolEnv(true),
    // Only required when the dev_api_key auth method is actually enabled —
    // see the superRefine below and auth/providers/dev-api-key.ts.
    DEV_API_KEY: z.string().min(1).optional(),
    LLM_PROVIDER: z.enum(['anthropic', 'openai', 'deepseek', 'ollama']),
    LLM_API_KEY: z.string().min(1),
    LLM_MODEL: z.string().min(1),
    // Overrides the default base URL for openai/deepseek/ollama (all share one
    // OpenAI-compatible adapter — see packages/llm-providers/src/registry.ts).
    // Leave unset to use each provider's default; irrelevant for anthropic.
    LLM_BASE_URL: z.string().url().optional(),
    APPROVAL_THRESHOLD_CENTS: z.coerce.number().int().nonnegative().default(2000),
    // Global default for audit log retention (RT-054) — unset means "never
    // auto-delete", same opt-in philosophy as WalletService. An org can
    // override with its own organizations.settings.auditRetentionDays.
    AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().optional(),
    SHORT_MEMORY_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
    RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(100),
    // Optional: the telegram-send tool 400s with a clear message if unset,
    // rather than every other route failing validation at startup.
    TELEGRAM_BOT_TOKEN: z.string().min(1).optional(),
    // AES-256-GCM master key for per-org llm_configs.api_key_encrypted (see
    // gateway/src/lib/crypto.ts). Generate with `openssl rand -hex 32`.
    CONFIG_ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i, 'must be a 64-char hex string (32 bytes)'),
    // RT-019 — set this to the OLD value of CONFIG_ENCRYPTION_KEY when
    // rotating it, so secrets already encrypted under the old key keep
    // decrypting (kms/env-provider.ts's 'previous' keyId) until
    // re-encrypt-on-read transparently migrates each row to the new
    // ('current') key. Safe to unset entirely once no row references
    // kms_key_id = 'previous' anymore.
    CONFIG_ENCRYPTION_KEY_PREVIOUS: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
    // Optional: enables semantic memory search (migrations/0008_vector_search.sql).
    // Only takes effect when LLM_PROVIDER is openai or ollama — see
    // packages/llm-providers/src/embedding.ts for why. Left unset, memory
    // search silently falls back to the plain ILIKE search it always had.
    EMBEDDING_MODEL: z.string().min(1).optional(),

    // --- T-CP-007: Control Plane activation client (optional — pure
    // self-host deployments leave both unset, and ActivationState.isActivated()
    // defaults to true in that case; self-host-first is this project's MVP
    // target, so an unconfigured Runtime must never read as "unactivated"). ---
    CONTROL_PLANE_URL: z.string().url().optional(),
    ACTIVATION_KEY: z.string().min(1).optional(),

    // --- Marketplace install-proxy (optional — unset disables /v1/marketplace/*
    // with a clear 501, same "off by default" contract as the two above). ---
    MARKETPLACE_SERVICE_URL: z.string().url().optional(),
    MARKETPLACE_API_KEY: z.string().min(1).optional(),

    // --- RT-014..018: Auth Method Registry (docs/spect/02_ARCHITECTURE/16-authentication-modes.md) ---

    // Node convention, not auth-specific, but the dev_api_key hardening
    // (RT-018) gates on it — see the superRefine below. Defaults to
    // 'production' (the Dockerfile also bakes NODE_ENV=production into the
    // runner stage) so a deployment has to *opt in* to dev-only auth, not
    // opt out of it.
    NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),

    // Comma-separated list of AuthMethod (packages/shared/src/schemas/auth.ts).
    // Deliberately no default — an empty/missing list fails startup (see
    // superRefine) rather than silently picking one, per the design doc's
    // "امن‌تر از default مبهم" rule.
    AUTH_METHODS_ENABLED: z.string().min(1),
    AUTH_METHODS_DEFAULT: z.string().optional(),
    AUTH_ALLOW_DEV_METHODS: boolEnv(false),

    // --- password provider (RT-015) ---
    PASSWORD_HASHER: z.literal('argon2id').default('argon2id'),
    PASSWORD_MIN_LENGTH: z.coerce.number().int().positive().default(10),

    // --- magic_link provider (RT-016) ---
    EMAIL_FROM: z.string().email().optional(),
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASS: z.string().min(1).optional(),
    // SMTP servers without auth (e.g. a local test catcher) still need
    // SMTP_USER/PASS to be *absent*, not empty strings — this flag makes
    // that explicit instead of inferring it from blank credentials.
    SMTP_SECURE: boolEnv(false),

    // Base URL of the web dashboard — used to build a clickable link in
    // invitation emails (routes/invitations.ts). Optional: if unset, the
    // email falls back to a raw token, same degrade-gracefully pattern as
    // the rest of this env file.
    WEB_URL: z.string().url().optional(),

    // --- oauth provider (RT-017) ---
    OAUTH_PROVIDERS: z.string().optional(),
    OAUTH_GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    OAUTH_GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    OAUTH_GITHUB_CLIENT_ID: z.string().min(1).optional(),
    OAUTH_GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
    OAUTH_CALLBACK_URL: z.string().url().optional(),

    // --- oidc/saml providers (RT-068/069): per-org IdP config lives in
    // sso_configs (services/sso-config-service.ts), NOT here — this is only
    // the gateway's own public base URL, shared by every org's redirect_uri
    // / ACS URL, same role OAUTH_CALLBACK_URL plays for google/github. ---
    SSO_CALLBACK_URL: z.string().url().optional(),

    // --- backup/restore (RT-071) — opt-in, whole-DB, local-disk-only. Off
    // by default, same "opt-in feature, no surprise behavior" philosophy as
    // AUDIT_RETENTION_DAYS. ---
    BACKUP_ENABLED: boolEnv(false),
    BACKUP_DIR: z.string().min(1).default('./backups'),
    BACKUP_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
    BACKUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),

    // --- RT-030: object storage (branding logo upload), MinIO/S3-compatible.
    // Optional: unset means POST /v1/organization/branding 400s with a clear
    // "not configured" error instead of a hard crash — same "degrade
    // gracefully" convention as SMTP/Marketplace/LOCALE_AI_API_KEY. ---
    MINIO_ENDPOINT: z.string().min(1).optional(),
    MINIO_PORT: z.coerce.number().int().positive().default(9000),
    MINIO_USE_SSL: boolEnv(false),
    MINIO_ROOT_USER: z.string().min(1).optional(),
    MINIO_ROOT_PASSWORD: z.string().min(1).optional(),
    MINIO_BUCKET: z.string().min(1).default('o2n-files'),
    // Base URL branding image URLs are served from — the org's own reverse
    // proxy in front of MinIO, since MinIO's own port usually isn't
    // internet-facing. Falls back to a direct MinIO URL (fine for local dev).
    MINIO_PUBLIC_URL: z.string().url().optional(),

    // --- RT-083: i18n — deliberately separate from LLM_API_KEY/LLM_PROVIDER
    // above (org-scoped BYOK chat), same reasoning Control Plane's CP-028
    // used: locale generation is a deployment-global, generate-once-and-
    // cache-to-disk operation, not a per-org chat cost. 'en' (the reference
    // locale) always works with this unset. ---
    LOCALE_AI_API_KEY: z.string().optional(),
    LOCALE_AI_MODEL: z.string().default('claude-3-5-haiku-20241022'),
  })
  .superRefine((env, ctx) => {
    const methods = csv(env.AUTH_METHODS_ENABLED);
    const known = new Set<string>(AUTH_METHOD_VALUES);

    if (methods.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_METHODS_ENABLED'],
        message: 'AUTH_METHODS_ENABLED must list at least one auth method — an empty list is not a safe default',
      });
      return;
    }
    for (const m of methods) {
      if (!known.has(m)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_METHODS_ENABLED'],
          message: `Unknown auth method "${m}" — expected one of ${AUTH_METHOD_VALUES.join(', ')}`,
        });
      }
    }
    if (env.AUTH_METHODS_DEFAULT && !methods.includes(env.AUTH_METHODS_DEFAULT)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['AUTH_METHODS_DEFAULT'],
        message: 'AUTH_METHODS_DEFAULT must be one of the methods listed in AUTH_METHODS_ENABLED',
      });
    }

    // RT-018: dev_api_key is a shared-secret bootstrap method with no
    // per-user credential — it must never be reachable in a real deployment
    // by accident. Both gates are required, not just AUTH_ALLOW_DEV_METHODS,
    // so a stray NODE_ENV=production in a dev script can't silently disable
    // the safety check instead of tripping it.
    if (methods.includes('dev_api_key')) {
      if (!env.AUTH_ALLOW_DEV_METHODS || env.NODE_ENV === 'production') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AUTH_METHODS_ENABLED'],
          message:
            'dev_api_key requires AUTH_ALLOW_DEV_METHODS=true and NODE_ENV!=production — refusing to start with it enabled otherwise',
        });
      }
      if (!env.DEV_API_KEY) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DEV_API_KEY'], message: 'required when dev_api_key is enabled' });
      }
    }

    if (methods.includes('magic_link')) {
      const required: Array<[string, unknown]> = [
        ['EMAIL_FROM', env.EMAIL_FROM],
        ['SMTP_HOST', env.SMTP_HOST],
        ['SMTP_PORT', env.SMTP_PORT],
      ];
      for (const [key, value] of required) {
        if (value === undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `required when magic_link is enabled` });
        }
      }
    }

    if (methods.includes('oauth')) {
      const providers = csv(env.OAUTH_PROVIDERS);
      if (providers.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['OAUTH_PROVIDERS'],
          message: 'required (comma-separated, e.g. "google,github") when oauth is enabled',
        });
      }
      if (!env.OAUTH_CALLBACK_URL) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OAUTH_CALLBACK_URL'], message: 'required when oauth is enabled' });
      }
      for (const p of providers) {
        if (p === 'google' && (!env.OAUTH_GOOGLE_CLIENT_ID || !env.OAUTH_GOOGLE_CLIENT_SECRET)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['OAUTH_GOOGLE_CLIENT_ID'],
            message: 'OAUTH_GOOGLE_CLIENT_ID and OAUTH_GOOGLE_CLIENT_SECRET are required when "google" is in OAUTH_PROVIDERS',
          });
        } else if (p === 'github' && (!env.OAUTH_GITHUB_CLIENT_ID || !env.OAUTH_GITHUB_CLIENT_SECRET)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['OAUTH_GITHUB_CLIENT_ID'],
            message: 'OAUTH_GITHUB_CLIENT_ID and OAUTH_GITHUB_CLIENT_SECRET are required when "github" is in OAUTH_PROVIDERS',
          });
        } else if (p !== 'google' && p !== 'github') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['OAUTH_PROVIDERS'],
            message: `Unknown oauth provider "${p}" — only "google" and "github" are supported`,
          });
        }
      }
    }

    // oidc/saml: unlike oauth above, there's no per-provider client id/secret
    // to check here — that's per-org, resolved at request time from
    // sso_configs. Only the shared callback base URL is a startup concern.
    if ((methods.includes('oidc') || methods.includes('saml')) && !env.SSO_CALLBACK_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SSO_CALLBACK_URL'],
        message: 'required when oidc or saml is enabled',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema> & {
  /** Parsed, validated view of AUTH_METHODS_ENABLED — computed once in loadEnv(), not re-split at every call site. */
  authMethods: readonly (typeof AUTH_METHOD_VALUES)[number][];
  oauthProviders: readonly string[];
};

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }
  const authMethods = csv(parsed.data.AUTH_METHODS_ENABLED) as Env['authMethods'];
  const oauthProviders = csv(parsed.data.OAUTH_PROVIDERS);
  return { ...parsed.data, authMethods, oauthProviders };
}
