import type { Env } from '../../env.js';
import { createEnvKmsProvider } from './env-provider.js';
import type { KmsProvider } from './types.js';

export interface KmsRegistry {
  /** Every new secret is encrypted with this provider — RT-020 would make the choice configurable (SECRETS_KMS_PRIMARY_PROVIDER); only 'env' exists to choose from today. */
  readonly primary: KmsProvider;
  /** Looks up the provider that encrypted an existing row, by its stored kms_provider_id — needed because rows encrypted before a primary-provider change must still resolve to the provider that can actually decrypt them. */
  resolve(providerId: string): KmsProvider;
}

export function createKmsRegistry(env: Env): KmsRegistry {
  const envProvider = createEnvKmsProvider({
    current: env.CONFIG_ENCRYPTION_KEY,
    previous: env.CONFIG_ENCRYPTION_KEY_PREVIOUS,
  });
  const providers = new Map<string, KmsProvider>([[envProvider.id, envProvider]]);

  return {
    primary: envProvider,
    resolve(providerId: string): KmsProvider {
      const provider = providers.get(providerId);
      if (!provider) throw new Error(`Unknown KMS provider: "${providerId}"`);
      return provider;
    },
  };
}
