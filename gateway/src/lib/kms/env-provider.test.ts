import { describe, it, expect } from 'vitest';
import { createEnvKmsProvider } from './env-provider.js';

const CURRENT_KEY = 'a'.repeat(64);
const PREVIOUS_KEY = 'b'.repeat(64);

describe('env KMS provider (RT-019)', () => {
  it('encrypt() tags the result with a fingerprint of the current key, and decrypt() round-trips with it', () => {
    const provider = createEnvKmsProvider({ current: CURRENT_KEY });
    const result = provider.encrypt('my-secret');
    expect(result.providerId).toBe('env');
    expect(result.keyId).toMatch(/^[0-9a-f]{16}$/);
    expect(provider.decrypt(result.ciphertext, result.keyId)).toBe('my-secret');
  });

  it('isStale() is false for the current key\'s own fingerprint, true for anything else', () => {
    const provider = createEnvKmsProvider({ current: CURRENT_KEY });
    const { keyId } = provider.encrypt('x');
    expect(provider.isStale(keyId)).toBe(false);
    expect(provider.isStale('0000000000000000')).toBe(true);
  });

  it(
    'a key rotation scenario: a fingerprint stays correct even after the env var holding that key changes role — ' +
      'this is exactly why keyId is a fingerprint of the key value, not a "current"/"previous" role label',
    () => {
      // Before rotation: only one key exists (held in what will later become "previous").
      const beforeRotation = createEnvKmsProvider({ current: PREVIOUS_KEY });
      const { ciphertext: oldCiphertext, keyId: oldKeyId } = beforeRotation.encrypt('pre-rotation-secret');

      // After rotation: operator moves the old key into CONFIG_ENCRYPTION_KEY_PREVIOUS,
      // generates a new CONFIG_ENCRYPTION_KEY. The row's stored keyId (oldKeyId) is
      // unchanged — it still identifies the same physical key, now sitting in the
      // "previous" slot instead of "current".
      const afterRotation = createEnvKmsProvider({ current: CURRENT_KEY, previous: PREVIOUS_KEY });
      expect(afterRotation.decrypt(oldCiphertext, oldKeyId)).toBe('pre-rotation-secret');
      expect(afterRotation.isStale(oldKeyId)).toBe(true); // no longer the current key -> re-encrypt-on-read should fire

      // New writes use the new current key, with its own (different) fingerprint.
      const { ciphertext: newCiphertext, keyId: newKeyId } = afterRotation.encrypt('post-rotation-secret');
      expect(newKeyId).not.toBe(oldKeyId);
      expect(afterRotation.decrypt(newCiphertext, newKeyId)).toBe('post-rotation-secret');
      expect(afterRotation.isStale(newKeyId)).toBe(false);
    },
  );

  it('decrypt() throws a clear, actionable error for a fingerprint it has no key for', () => {
    const provider = createEnvKmsProvider({ current: CURRENT_KEY });
    const { ciphertext } = provider.encrypt('x');
    expect(() => provider.decrypt(ciphertext, 'deadbeefdeadbeef')).toThrow(/CONFIG_ENCRYPTION_KEY_PREVIOUS/);
  });
});
