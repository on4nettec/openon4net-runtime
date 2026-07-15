import type { SsoConfigSetInput, SsoProtocol } from '@o2n/shared';
import { NotFoundError } from '@o2n/governance';
import type { Queryable } from '../db.js';
import type { Env } from '../env.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';

interface SsoConfigRow {
  organization_id: string;
  protocol: SsoProtocol;
  config: Record<string, string>;
  secret_encrypted: Buffer | null;
  is_enabled: boolean;
  created_at: string;
  updated_at: string;
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
  constructor(
    private db: Queryable,
    private env: Env,
  ) {}

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

  /** Decrypts the secret for actual use (OIDC token exchange) — never exposed via getEffectiveConfig(). */
  async resolve(organizationId: string): Promise<ResolvedSsoConfig | null> {
    const row = await this.getRow(organizationId);
    if (!row || !row.is_enabled) return null;
    const secret = row.secret_encrypted ? decryptSecret(row.secret_encrypted, this.env.CONFIG_ENCRYPTION_KEY) : null;
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
    const encrypted = secretPlain ? encryptSecret(secretPlain, this.env.CONFIG_ENCRYPTION_KEY) : null;

    await this.db.query(
      `INSERT INTO sso_configs (organization_id, protocol, config, secret_encrypted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id) DO UPDATE SET
         protocol = EXCLUDED.protocol, config = EXCLUDED.config,
         secret_encrypted = EXCLUDED.secret_encrypted, updated_at = NOW()`,
      [organizationId, input.protocol, JSON.stringify(config), encrypted],
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
