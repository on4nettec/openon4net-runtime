import { createHash } from 'node:crypto';
import { decryptSecret, encryptSecret } from '../crypto.js';
import type { KmsEncryptResult, KmsProvider } from './types.js';

/**
 * keyId is a fingerprint of the key material itself (sha256, truncated),
 * NOT a role label like "current"/"previous" — a role label would silently
 * go stale the moment CONFIG_ENCRYPTION_KEY_PREVIOUS gets rotated again
 * (a row stored as keyId="current" would suddenly mean the wrong key once
 * "current" points somewhere else). A fingerprint stays correct forever
 * because it's derived from the key value, not from which env var
 * currently holds it.
 */
function fingerprint(masterKeyHex: string): string {
  return createHash('sha256').update(masterKeyHex).digest('hex').slice(0, 16);
}

/**
 * RT-019 — the only KMS provider today: env-var master key(s), same
 * AES-256-GCM scheme lib/crypto.ts always used. Both CONFIG_ENCRYPTION_KEY
 * (current) and CONFIG_ENCRYPTION_KEY_PREVIOUS (optional, set during a
 * rotation window) are indexed by fingerprint so old rows keep decrypting
 * correctly no matter how many times the "current" key changes later.
 */
export function createEnvKmsProvider(keys: { current: string; previous?: string | undefined }): KmsProvider {
  const currentFingerprint = fingerprint(keys.current);
  const keysByFingerprint = new Map<string, string>([[currentFingerprint, keys.current]]);
  if (keys.previous) {
    keysByFingerprint.set(fingerprint(keys.previous), keys.previous);
  }

  return {
    id: 'env',

    encrypt(plaintext: string): KmsEncryptResult {
      return {
        ciphertext: encryptSecret(plaintext, keys.current),
        providerId: 'env',
        keyId: currentFingerprint,
        keyVersion: 1,
      };
    },

    decrypt(ciphertext: Buffer, keyId: string): string {
      const key = keysByFingerprint.get(keyId);
      if (!key) {
        throw new Error(
          `env KMS provider has no key matching fingerprint "${keyId}" — set CONFIG_ENCRYPTION_KEY_PREVIOUS to the rotated-out key if this row predates the last rotation`,
        );
      }
      return decryptSecret(ciphertext, key);
    },

    isStale(keyId: string): boolean {
      return keyId !== currentFingerprint;
    },
  };
}
