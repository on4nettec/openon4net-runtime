import type { SsoConfigSetInput, SsoProtocol } from '@o2n/shared';
import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';
import type { Env } from '../env.js';
import { createKmsRegistry, type KmsRegistry } from '../lib/kms/registry.js';

interface SsoConfigRow {
  organization_id: string;
  protocol: SsoProtocol;
  config: Record<string, string>;
  secret_encrypted: Buffer | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
  kms_provider_id: string;
  kms_key_id: string;
}

export interface EffectiveSsoConfig {
  protocol: SsoProtocol;
  config: Record<string, string>;
  hasSecret: boolean;
  isEnabled: boolean;
}

export interface ResolvedSsoConfig {
  protocol: SsoProtocol;
  config: Record<string, string>;
  secret: string | null;
}

/**
 * Per-org identity-provider configuration (RT-068/069) — mirrors
 * ProviderConfigService's shape (provider-config-service.ts):
 * getEffectiveConfig() masks the secret for display, resolve() decrypts it
 * for actual use during a login flow, setConfig() encrypts on write.
 */
export class SsoConfigService {
  private kms: KmsRegistry;

  constructor(
    private db: Queryable,
    private env: Env,
  ) {
    this.kms = createKmsRegistry(env);
  }

  async getEffectiveConfig(organizationId: string): Promise<EffectiveSsoConfig | null> {
    const row = await this.getRow(organizationId);
    if (!row) return null;
    return {
      protocol: row.protocol,
      config: row.config,
      hasSecret: row.secret_encrypted !== null,
      isEnabled: row.is_enabled,
    };
  }

  /** Decrypts the secret for actual use (OIDC token exchange) — never exposed via getEffectiveConfig(). Re-encrypts on read (RT-019) when the stored key has been rotated out, same best-effort pattern as ProviderConfigService. */
  async resolve(organizationId: string): Promise<ResolvedSsoConfig | null> {
    const row = await this.getRow(organizationId);
    if (!row || !row.is_enabled) return null;
    if (!row.secret_encrypted) return { protocol: row.protocol, config: row.config, secret: null };

    const provider = this.kms.resolve(row.kms_provider_id);
    const secret = provider.decrypt(row.secret_encrypted, row.kms_key_id);
    if (provider.isStale(row.kms_key_id)) {
      try {
        const rotated = this.kms.primary.encrypt(secret);
        await this.db.query(
          `UPDATE sso_configs SET secret_encrypted = $1, kms_provider_id = $2, kms_key_id = $3, kms_key_version = $4 WHERE organization_id = $5`,
          [rotated.ciphertext, rotated.providerId, rotated.keyId, rotated.keyVersion, organizationId],
        );
      } catch {
        // Best-effort — next read just retries the rotation.
      }
    }
    return { protocol: row.protocol, config: row.config, secret };
  }

  async setConfig(organizationId: string, input: SsoConfigSetInput): Promise<EffectiveSsoConfig> {
    let config: Record<string, string>;
    let secretPlain: string | null;
    if (input.protocol === 'oidc') {
      config = { issuerUrl: input.issuerUrl, clientId: input.clientId };
      secretPlain = input.clientSecret;
    } else {
      config = { entityId: input.entityId, ssoUrl: input.ssoUrl, certificate: input.certificate };
      secretPlain = null;
    }
    const encrypted = secretPlain ? this.kms.primary.encrypt(secretPlain) : null;

    await this.db.query(
      `INSERT INTO sso_configs (organization_id, protocol, config, secret_encrypted, kms_provider_id, kms_key_id, kms_key_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (organization_id) DO UPDATE SET
         protocol = EXCLUDED.protocol, config = EXCLUDED.config,
         secret_encrypted = EXCLUDED.secret_encrypted,
         kms_provider_id = EXCLUDED.kms_provider_id, kms_key_id = EXCLUDED.kms_key_id, kms_key_version = EXCLUDED.kms_key_version,
         updated_at = NOW()`,
      [
        organizationId,
        input.protocol,
        JSON.stringify(config),
        encrypted?.ciphertext ?? null,
        encrypted?.providerId ?? 'env',
        encrypted?.keyId ?? 'current',
        encrypted?.keyVersion ?? 1,
      ],
    );
    const result = await this.getEffectiveConfig(organizationId);
    if (!result) throw new Error('setConfig did not persist a row');
    return result;
  }

  async delete(organizationId: string): Promise<void> {
    const { rowCount } = await this.db.query(`DELETE FROM sso_configs WHERE organization_id = $1`, [organizationId]);
    if (!rowCount) throw new NotFoundError('SsoConfig', organizationId);
  }

  private async getRow(organizationId: string): Promise<SsoConfigRow | null> {
    const { rows } = await this.db.query<SsoConfigRow>(`SELECT * FROM sso_configs WHERE organization_id = $1`, [organizationId]);
    return rows[0] ?? null;
  }
}
