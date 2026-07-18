import { getProvider, type LlmProvider, type SupportedProvider } from '@o2n/llm-providers';
import { ValidationError } from '@o2n/governance';
import type { Queryable } from '../db.js';
import type { Env } from '../env.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';

const SUPPORTED_PROVIDERS: SupportedProvider[] = ['anthropic', 'openai', 'deepseek', 'ollama'];

interface LlmConfigRow {
  provider: SupportedProvider;
  model: string;
  api_key_encrypted: Buffer;
  base_url: string | null;
}

export interface EffectiveConfig {
  provider: SupportedProvider;
  model: string;
  apiKeyMasked: string;
  baseUrl: string | null;
  source: 'database' | 'env';
}

export interface SetConfigInput {
  provider: SupportedProvider;
  model: string;
  // RT-089 — optional for ollama (LlmConfigSetSchema enforces "required
  // unless ollama" upstream); falls back to the same 'ollama' placeholder
  // registry.ts's own getProvider() comment recommends.
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}${'•'.repeat(key.length - 8)}${key.slice(-4)}`;
}

/**
 * Resolves the active BYOK provider per organization: a `llm_configs` DB row
 * overrides the env-wide default (LLM_PROVIDER/LLM_API_KEY/LLM_MODEL),
 * letting self-hosted admins switch providers from the dashboard instead of
 * editing .env + restarting the gateway (see docs/spect/02_ARCHITECTURE/
 * 11-secrets-and-key-management.md §3.1 — env-first storage, DB overrides
 * use envelope encryption per §4). Runtime stays single-provider-per-org;
 * still no cross-provider routing/fallback (that's Control Plane's job).
 *
 * Provider instances are cached per organization and invalidated on write —
 * constructing a provider client (esp. the Anthropic/OpenAI SDKs) on every
 * chat call would be wasteful.
 */
export class ProviderConfigService {
  private cache = new Map<string, { key: string; provider: LlmProvider; model: string; providerName: string }>();

  constructor(
    private db: Queryable,
    private env: Env,
  ) {}

  async getEffectiveConfig(organizationId: string): Promise<EffectiveConfig> {
    const row = await this.getRow(organizationId);
    if (!row) {
      return {
        provider: this.env.LLM_PROVIDER,
        model: this.env.LLM_MODEL,
        apiKeyMasked: maskKey(this.env.LLM_API_KEY),
        baseUrl: this.env.LLM_BASE_URL ?? null,
        source: 'env',
      };
    }
    const apiKey = decryptSecret(row.api_key_encrypted, this.env.CONFIG_ENCRYPTION_KEY);
    return {
      provider: row.provider,
      model: row.model,
      apiKeyMasked: maskKey(apiKey),
      baseUrl: row.base_url,
      source: 'database',
    };
  }

  /** Returns a ready-to-use LlmProvider + default model for this org, backed by a per-org cache. */
  async resolve(organizationId: string): Promise<{ provider: LlmProvider; model: string; providerName: string }> {
    const row = await this.getRow(organizationId);
    const apiKey = row ? decryptSecret(row.api_key_encrypted, this.env.CONFIG_ENCRYPTION_KEY) : this.env.LLM_API_KEY;
    const providerName = row?.provider ?? this.env.LLM_PROVIDER;
    const model = row?.model ?? this.env.LLM_MODEL;
    const baseUrl = row?.base_url ?? this.env.LLM_BASE_URL;

    const cacheKey = `${providerName}:${apiKey}:${model}:${baseUrl ?? ''}`;
    const cached = this.cache.get(organizationId);
    if (cached && cached.key === cacheKey) {
      return { provider: cached.provider, model: cached.model, providerName: cached.providerName };
    }

    const provider = getProvider(providerName, apiKey, baseUrl ?? undefined);
    this.cache.set(organizationId, { key: cacheKey, provider, model, providerName });
    return { provider, model, providerName };
  }

  async setConfig(organizationId: string, updatedBy: string, input: SetConfigInput): Promise<EffectiveConfig> {
    if (!SUPPORTED_PROVIDERS.includes(input.provider)) {
      throw new ValidationError(`Unsupported provider: ${input.provider}`);
    }
    const apiKey = input.apiKey || (input.provider === 'ollama' ? 'ollama' : '');
    const encrypted = encryptSecret(apiKey, this.env.CONFIG_ENCRYPTION_KEY);
    await this.db.query(
      `INSERT INTO llm_configs (organization_id, provider, model, api_key_encrypted, base_url, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (organization_id) DO UPDATE SET
         provider = EXCLUDED.provider, model = EXCLUDED.model,
         api_key_encrypted = EXCLUDED.api_key_encrypted, base_url = EXCLUDED.base_url,
         updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [organizationId, input.provider, input.model, encrypted, input.baseUrl ?? null, updatedBy],
    );
    this.cache.delete(organizationId);
    return this.getEffectiveConfig(organizationId);
  }

  private async getRow(organizationId: string): Promise<LlmConfigRow | null> {
    const { rows } = await this.db.query<LlmConfigRow>(
      `SELECT provider, model, api_key_encrypted, base_url FROM llm_configs WHERE organization_id = $1`,
      [organizationId],
    );
    return rows[0] ?? null;
  }
}
