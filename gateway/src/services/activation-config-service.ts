import type { Queryable } from '../db.js';
import type { Env } from '../env.js';
import { createKmsRegistry, type KmsRegistry } from '../lib/kms/registry.js';

interface ActivationConfigRow {
  activation_key_encrypted: Buffer;
  kms_provider_id: string;
  kms_key_id: string;
}

/**
 * RT-092 — a DB-stored activation key, overriding env.ACTIVATION_KEY the
 * same way llm_configs/sso_configs override their own env defaults
 * (provider-config-service.ts/sso-config-service.ts) — same envelope
 * encryption (RT-019's KMS registry), same singleton-row shape reasoning
 * as those two: one Runtime deployment, one activation relationship.
 */
export class ActivationConfigService {
  private kms: KmsRegistry;

  constructor(
    private db: Queryable,
    env: Env,
  ) {
    this.kms = createKmsRegistry(env);
  }

  async getActivationKey(): Promise<string | null> {
    const { rows } = await this.db.query<ActivationConfigRow>(
      `SELECT activation_key_encrypted, kms_provider_id, kms_key_id FROM activation_config WHERE id = 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const provider = this.kms.resolve(row.kms_provider_id);
    return provider.decrypt(row.activation_key_encrypted, row.kms_key_id);
  }

  async setActivationKey(activationKey: string, configuredByUserId: string): Promise<void> {
    const encrypted = this.kms.primary.encrypt(activationKey);
    await this.db.query(
      `INSERT INTO activation_config (id, activation_key_encrypted, kms_provider_id, kms_key_id, kms_key_version, configured_by_user_id, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, NOW())
       ON CONFLICT (id) DO UPDATE SET
         activation_key_encrypted = EXCLUDED.activation_key_encrypted,
         kms_provider_id = EXCLUDED.kms_provider_id,
         kms_key_id = EXCLUDED.kms_key_id,
         kms_key_version = EXCLUDED.kms_key_version,
         configured_by_user_id = EXCLUDED.configured_by_user_id,
         updated_at = NOW()`,
      [encrypted.ciphertext, encrypted.providerId, encrypted.keyId, encrypted.keyVersion, configuredByUserId],
    );
  }
}
