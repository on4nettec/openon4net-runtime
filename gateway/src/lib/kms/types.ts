export interface KmsEncryptResult {
  ciphertext: Buffer;
  providerId: string;
  keyId: string;
  keyVersion: number;
}

/**
 * RT-019 — one implementation per KMS backend. 'env' (the only one that
 * exists today) is a thin wrapper around lib/crypto.ts's AES-256-GCM
 * primitives; RT-020 (currently deferred — see docs/spect/06_MEETINGS)
 * would add a 'vault' implementation of this same interface, registered
 * alongside 'env' in kms-registry.ts without touching any secret already
 * encrypted under 'env'.
 */
export interface KmsProvider {
  readonly id: string;
  /** Always encrypts with this provider's current/primary key. */
  encrypt(plaintext: string): KmsEncryptResult;
  /** Decrypts using the specific keyId a row was originally encrypted with — rotating the "current" key must never break old rows. */
  decrypt(ciphertext: Buffer, keyId: string): string;
  /** True when keyId isn't this provider's current key anymore — signals re-encrypt-on-read should run. */
  isStale(keyId: string): boolean;
}
